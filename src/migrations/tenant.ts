/**
 * One tenant's schema changes, from a Durable Object (plan D4).
 *
 * A helper over `createMigrationClient`, not a second composition root: a
 * change is that client's `generate` and `apply`, run one at a time per
 * migrator, and what they throw comes back as one of five outcomes.
 */

import { isRetryableError, isVibORMError, VibORMErrorCode } from "../errors";
import {
  createMigrationClient,
  type ReadableMigrations,
  type WritableMigrations,
} from "./client";
import { isDestructiveOperation } from "./differ";
import type { Sha256 } from "./identity";
import type { MigrationLimits } from "./limits";
import type { MigrationClient } from "./push/planner";
import { createPredefinedResolver } from "./resolver";
import type {
  MigrationStorageReader,
  MigrationStorageWriter,
} from "./storage/contract";
import type { ResolveCallback } from "./types";
import type { MigrationDecisionV1, MigrationMarkerV1 } from "./v1-types";

export interface TenantMigratorOptions {
  /**
   * Any client on the tenant's database. `change` uses its connection with
   * the schema it is given; `status`, `log`, `resolve`, `down` and
   * `reanchor` use the client as it is.
   */
  readonly client: MigrationClient;
  /** The tenant's history: `createDurableObjectStorageWriter(ctx.storage)`. */
  readonly history: MigrationStorageWriter;
  /** The managed tables, as `createMigrationClient`'s `tables`. */
  readonly tables?: readonly string[];
  readonly limits?: MigrationLimits;
}

export interface TenantChangeOptions {
  /** Renames, enum mappings and approved destructive changes, as data. */
  readonly decisions?: readonly MigrationDecisionV1[];
  /**
   * Checked while queued, before `beforeDestructive`, before publishing and
   * during retry backoff. Once a state is published `apply` runs, and is
   * never interrupted: bound it with `limits`.
   */
  readonly signal?: AbortSignal;
  /**
   * Awaited after the preview and before any effect when the change, or a
   * published state `apply` reaches first, is destructive. If it throws, the
   * change is `refused`.
   */
  readonly beforeDestructive?: () => unknown;
}

/** An error as plain data, so an outcome crosses Durable Object RPC intact. */
export interface TenantChangeError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
}

export type TenantChangeResult =
  | {
      readonly kind: "applied";
      readonly path: readonly Sha256[];
      readonly warnings?: readonly string[];
    }
  | { readonly kind: "noop" }
  | {
      /**
       * `refused`: this call changed nothing. `failed`: the change did not
       * reach its state, which may be published; calling again may. A
       * refusal of a state this call published is `failed`. `ambiguous`: the
       * database may be between states; read `status()`, then `resolve()`.
       */
      readonly kind: "refused" | "failed" | "ambiguous";
      readonly error: TenantChangeError;
      /** `status().marker` after an apply attempt, when it could be read. */
      readonly marker?: MigrationMarkerV1 | null;
    };

export interface TenantMigrator {
  change(
    schema: MigrationClient["$schema"],
    options?: TenantChangeOptions
  ): Promise<TenantChangeResult>;
  status: ReadableMigrations["status"];
  log: ReadableMigrations["log"];
  resolve: ReadableMigrations["resolve"];
  down: ReadableMigrations["down"];
  /** After a restore left this object's history older than the database. */
  reanchor: ReadableMigrations["reanchor"];
  /**
   * Copies an authored checkpoint and what follows it into a fresh history,
   * such as `createDurableObjectStorageWriter(ctx.storage, { prefix })`;
   * a migrator over it then calls `reanchor()`.
   */
  prune: ReadableMigrations["prune"];
}

const AMBIGUOUS = new Set<string>([
  VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
  VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
  VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
]);
/** An attempt that rolled back, or lost the marker to another writer. */
const FAILED = new Set<string>([
  VibORMErrorCode.MIGRATION_FAILED,
  VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
]);
const ATTEMPTS = 4;
const BACKOFF_MS = 200;

/**
 * `change`, `resolve`, `down`, `reanchor` and `prune` run one at a time: a call made while another
 * runs waits for it, and leaves the queue as `failed` if its signal aborts
 * first. Call them from a request or an alarm, never from the constructor or
 * `blockConcurrencyWhile`.
 */
export function createTenantMigrator({
  client,
  history,
  tables,
  limits,
}: TenantMigratorOptions): TenantMigrator {
  const options = { storage: history, tables, limits };
  const current = createMigrationClient(client, options);
  let tail: Promise<unknown> = Promise.resolve();
  const exclusive = async <T>(
    run: () => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> => {
    const previous = tail;
    let release = (): void => undefined;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    }).then(() => previous);
    try {
      await untilAborted(previous, signal);
      return await run();
    } finally {
      release();
    }
  };

  const change = async (
    schema: MigrationClient["$schema"],
    { decisions = [], signal, beforeDestructive }: TenantChangeOptions = {}
  ): Promise<TenantChangeResult> => {
    let published: boolean;
    let migrations: WritableMigrations;
    try {
      signal?.throwIfAborted();
      migrations = createMigrationClient(
        { $driver: client.$driver, $schema: schema },
        options
      );
      const resolve = createPredefinedResolver(decisions);
      if (
        beforeDestructive &&
        (await isDestructive(migrations, resolve, history))
      ) {
        signal?.throwIfAborted();
        try {
          await beforeDestructive();
        } catch (failure) {
          return { kind: "refused", error: describe(failure) };
        }
      }
      signal?.throwIfAborted();
      const generated = await migrations.generate({ resolve });
      published = generated.outcome === "published";
    } catch (failure) {
      return { kind: classify(failure), error: describe(failure) };
    }
    for (let attempt = 1; ; attempt += 1) {
      try {
        const applied = await migrations.apply();
        if (applied.outcome === "noop" && !published) return { kind: "noop" };
        return {
          kind: "applied",
          path: applied.path,
          ...(applied.warnings ? { warnings: applied.warnings } : {}),
        };
      } catch (failure) {
        const refusal = classify(failure);
        // The state this call published is an effect: its refusal is a failure.
        const kind = published && refusal === "refused" ? "failed" : refusal;
        if (
          attempt === ATTEMPTS ||
          kind !== "failed" ||
          !retryable(failure) ||
          !(await backoff(attempt, signal))
        ) {
          return withMarker({ kind, error: describe(failure) }, migrations);
        }
      }
    }
  };

  return Object.freeze({
    change: (schema, options) =>
      exclusive(() => change(schema, options), options?.signal).catch(
        (failure: unknown) => ({
          kind: "failed" as const,
          error: describe(failure),
        })
      ),
    status: () => current.status(),
    log: () => current.log(),
    resolve: (options) => exclusive(() => current.resolve(options)),
    down: (options) => exclusive(() => current.down(options)),
    reanchor: (options) => exclusive(() => current.reanchor(options)),
    prune: (options) => exclusive(() => current.prune(options)),
  });
}

/**
 * Whether the change previews a loss, or a published state `apply` would
 * reach first carries one or an approval.
 */
async function isDestructive(
  migrations: WritableMigrations,
  resolve: ResolveCallback,
  history: MigrationStorageReader
): Promise<boolean> {
  const preview = await migrations.generate({ dryRun: true, resolve });
  if (preview.operations.some(isDestructiveOperation)) return true;
  // A first change has no history (`graph()` refuses it): nothing published
  // can carry a loss.
  if (!(await history.readEstate())) return false;
  const { states, edges } = await migrations.graph();
  if (states.length === 0) return false;
  const { path } = await migrations.apply({ dryRun: true });
  return edges.some(
    (edge) =>
      path.includes(edge.toState) &&
      (edge.approvals.length > 0 || edge.risks.includes("destructive"))
  );
}

/** A transient failure, or the migration lock another command holds. */
function retryable(failure: unknown): boolean {
  if (
    isVibORMError(failure) &&
    failure.code === VibORMErrorCode.MIGRATION_LOCK_FAILED
  ) {
    return true;
  }
  for (let link = failure; link instanceof Error; link = link.cause) {
    if (isRetryableError(link)) return true;
  }
  return false;
}

/**
 * VibORM's refusals are `refused`; anything else unexpected is `failed`. A
 * possible commit stays `ambiguous` whatever caused it: it is never retried.
 */
function classify(failure: unknown): "refused" | "failed" | "ambiguous" {
  if (!isVibORMError(failure)) return "failed";
  if (AMBIGUOUS.has(failure.code)) return "ambiguous";
  return FAILED.has(failure.code) || retryable(failure) ? "failed" : "refused";
}

/** The state reached, read again: since 1.1.0 a change may commit in steps. */
async function withMarker(
  result: Extract<TenantChangeResult, { error: TenantChangeError }>,
  migrations: ReadableMigrations
): Promise<TenantChangeResult> {
  try {
    return { ...result, marker: (await migrations.status()).marker };
  } catch {
    return result;
  }
}

function describe(failure: unknown): TenantChangeError {
  if (!(failure instanceof Error)) {
    return { name: "Error", message: String(failure) };
  }
  return {
    name: failure.name,
    ...(isVibORMError(failure) ? { code: failure.code } : {}),
    message: failure.message,
  };
}

/** Waits for `previous`, or rejects with the signal's reason first. */
function untilAborted(
  previous: Promise<unknown>,
  signal: AbortSignal | undefined
): Promise<unknown> {
  if (!signal) return previous;
  signal.throwIfAborted();
  let abort = (): void => undefined;
  const aborted = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
  });
  return Promise.race([previous, aborted]).finally(() =>
    signal.removeEventListener("abort", abort)
  );
}

/** Jittered exponential backoff; false when the signal aborts the wait. */
async function backoff(
  attempt: number,
  signal: AbortSignal | undefined
): Promise<boolean> {
  const ms = BACKOFF_MS * 2 ** (attempt - 1) * (0.5 + Math.random() / 2);
  try {
    await untilAborted(
      new Promise((resolve) => setTimeout(resolve, ms)),
      signal
    );
    return true;
  } catch {
    return false;
  }
}
