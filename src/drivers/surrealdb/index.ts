/**
 * `viborm/surrealdb`: a driver whose database reads SurrealQL. {@link SurrealQueries}
 * and {@link SurrealOperationContext} write its statements, and it declares only what
 * the engine asks of any driver. `docs/architecture/query-backend-frontier.md`.
 */

import { passThroughParseResult } from "@adapters/adapter-result-parser";
import type { EngineFacts } from "@adapters/database-adapter";
import {
  createClientFromDriverConfig,
  type DriverConfig,
  type LinkedClientConfig,
  type NoExtraDriverConfigKeys,
  type VibORMClient,
} from "@client/client";
import type { Schema } from "@client/types";
import {
  ClientInitializationError,
  ForbiddenError,
  ForeignKeyError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  VibORMErrorCode,
} from "@errors";
import { queryBackend } from "@query-engine/raptor3/shared/query-backend";
import type { Sql } from "@sql";
import {
  DateTime,
  Decimal,
  GeometryPoint,
  RecordId,
  SizedNumber,
  Surreal,
  Uuid,
} from "surrealdb";
import {
  type CommitRerunningDriver,
  Driver,
  TransactionBoundDriver,
} from "../driver";
import { getExecutionTransactionPhases } from "../execution-context";
import type {
  DriverTransactionOptions,
  TransactionOptionSupport,
  TransactionOptions,
} from "../shared";
import { refuseUnknownDriverConfigKeys } from "../shared/driver-options";
import { createTransactionCleanupError } from "../shared/transactions";
import type { QueryExecutionContext, QueryResult } from "../types";
import { SurrealOperationContext } from "./operation-context";
import { SurrealQueries } from "./queries";
import {
  COMMITS,
  FORBIDDEN_ROW,
  isConflict,
  ReplayedTransaction,
  WAITING_FAILED,
} from "./transaction";

/**
 * A statement that holds what it reads ahead of itself, where no transaction
 * holds it: this driver makes it one transaction of its own.
 */
const standsAlone = (client: unknown, statement: string): boolean =>
  !(client instanceof ReplayedTransaction) && statement.startsWith("LET ");

/** What the engine asks of any driver. */
const FACTS: EngineFacts = {
  namespace: undefined,
  // A point's statements are this driver's own: the fact is that it holds them.
  geoPoint: {},
  // A strategy `Commands` asks about, not syntax: `INSERT IGNORE` skips.
  mutations: { skipDuplicatesStrategy: "sql" },
  // A widened sum asks whether it travels in parts here, and it never does.
  aggregates: {},
  result: {
    nativeScalarPassthrough: true,
    parseResult: passThroughParseResult,
    parseRelation: (_value, next) => next(),
    parseField: (_value, _type, next) => next(),
  },
  capabilities: {
    supportsReturning: true,
    supportsCteWithMutations: false,
    supportsFullOuterJoin: false,
    supportsLateralJoins: false,
    supportsVector: true,
    supportsUpsertWhere: false,
    supportsTargetedUpsert: true,
    supportsMutationTargetInSubquery: false,
    supportsMutationRowLimit: false,
    supportsRowLocks: false,
  },
};

/** A provider value as the engine's decoders read it. */
function plain(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof RecordId) return plain(value.id);
  if (value instanceof GeometryPoint) return value.toJSON();
  if (value instanceof DateTime) return value.toISOString();
  if (value instanceof Decimal || value instanceof Uuid)
    return value.toString();
  if (value instanceof SizedNumber) return value.value;
  if (Array.isArray(value)) return value.map(plain);
  if (ArrayBuffer.isView(value)) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const members = Object.entries(value).map(([key, member]) => [
      key,
      plain(member),
    ]);
    // The SDK decodes a map by assignment, so a stored `__proto__` key becomes the
    // object's prototype, which every read of the row would then inherit from.
    const inherited = Object.getPrototypeOf(value);
    if (
      inherited === null ||
      (inherited !== Object.prototype &&
        Object.getPrototypeOf(inherited) === Object.prototype &&
        !Object.hasOwn(inherited, "constructor"))
    )
      members.unshift(["__proto__", plain(inherited)]);
    return Object.fromEntries(members);
  }
  return value;
}

const UNIQUE_REFUSAL = /already contains|already exists/;
const REFERENCE_REFUSAL =
  /must conform to.*exists\(\)|ON (?:DELETE|UPDATE) REJECT/s;
const OUT_OF_RANGE =
  /Expected `(?:none \| )?i32` but found|must conform to.*math::abs|Cannot perform (?:addition|subtraction|multiplication) with/s;
const TOO_DEEP = /Exceeded (?:query|expression) recursion depth limit/;

/**
 * A provider failure in viborm's own words. Refusals carry no code here, so their
 * sentences are the only evidence.
 */
function refusal(error: unknown): unknown {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error : undefined;
  if (isConflict(error)) return new TransactionError(message, { cause });
  // Its operation's own error, which it reads from the mark.
  if (WAITING_FAILED.test(message)) return new QueryError(message, { cause });
  if (message.includes(FORBIDDEN_ROW))
    return new ForbiddenError("row", "write", { cause });
  if (UNIQUE_REFUSAL.test(message))
    return new UniqueConstraintError(`Unique constraint failed: ${message}`, {
      cause,
    });
  if (REFERENCE_REFUSAL.test(message))
    return new ForeignKeyError(message, { cause });
  if (OUT_OF_RANGE.test(message))
    return new QueryError(message, {
      cause,
      code: VibORMErrorCode.QUERY_OUT_OF_RANGE,
    });
  if (TOO_DEEP.test(message))
    return new UnsupportedOperationError(
      "This statement nests deeper than the SurrealDB server parses: raise its SURREAL_MAX_QUERY_PARSING_DEPTH, or read in two steps.",
      { cause }
    );
  return error;
}

/** SurrealQL names its parameters: `$p1`, as {@link SurrealDriver.execute} binds them. */
function namedStatement(query: Sql): string {
  return query.strings.reduce(
    (text, next, index) => `${text}$p${index}${next}`
  );
}

class SurrealTransactionDriver extends TransactionBoundDriver<
  Surreal,
  ReplayedTransaction
> {
  readonly replayed: ReplayedTransaction;

  constructor(
    base: Driver<Surreal, ReplayedTransaction>,
    tx: ReplayedTransaction,
    context?: QueryExecutionContext
  ) {
    super(base, tx, context);
    this.replayed = tx;
  }

  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: ReplayedTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(this, tx, context);
  }

  /** A nested scope is a savepoint, which the transaction keeps for itself. */
  protected override async transaction<T>(
    client: Surreal | ReplayedTransaction,
    fn: (tx: ReplayedTransaction) => Promise<T>
  ): Promise<T> {
    const tx = client as ReplayedTransaction;
    const mark = tx.mark;
    try {
      return await fn(tx);
    } catch (error) {
      await tx.rollbackTo(mark).catch((cleanup: unknown) => {
        throw createTransactionCleanupError(error, [cleanup]);
      });
      throw error;
    }
  }
}

const CALLBACK = "$transaction(callback)";

export interface SurrealDriverOptions {
  /** A client you connected, which stays yours: the driver never closes it. */
  readonly client?: Surreal;
  /** Where to connect, when the driver opens its own client. */
  readonly url?: string;
  readonly namespace?: string;
  readonly database?: string;
  readonly authentication?: {
    readonly username: string;
    readonly password: string;
  };
  /**
   * How many more times a `$transaction` callback may run when a concurrent write
   * changed what it read, instead of failing with `V5001`. PostgreSQL would make it
   * wait, and running it again is the only way to give it the new value. Everything
   * the callback does outside the database happens again too, such as sending an
   * email, so this is off unless asked for.
   */
  readonly rerunsOnConflict?: number;
}

export class SurrealDriver
  extends Driver<Surreal, ReplayedTransaction>
  implements CommitRerunningDriver
{
  readonly adapter = FACTS;
  override readonly backend = queryBackend({
    queries: SurrealQueries,
    context: SurrealOperationContext,
  });
  readonly supportsTransactions = true;
  readonly supportsBatch = false;
  readonly supportsOrderedCommittedSegments = false;

  readonly #rerunsOnConflict: number;
  readonly #options: SurrealDriverOptions;

  constructor(options: SurrealDriverOptions = {}) {
    super("surrealql", "surrealdb");
    if (options.client) this.client = options.client;
    this.#options = options;
    this.#rerunsOnConflict = options.rerunsOnConflict ?? 0;
  }

  /**
   * A caller's callback runs again only when asked. A conflict its statements can
   * replay never reaches here, and a coordinated extension has already collected
   * what the failed run wrote, so its callback does not run twice.
   */
  override async withTransaction<T>(
    fn: (txDriver: Driver<Surreal, ReplayedTransaction>) => Promise<T>,
    options?: TransactionOptions,
    context?: QueryExecutionContext
  ): Promise<T> {
    let reruns =
      context?.operation === CALLBACK && !getExecutionTransactionPhases(context)
        ? this.#rerunsOnConflict
        : 0;
    for (let run = 1; ; run++) {
      let replayed: ReplayedTransaction | undefined;
      try {
        return await super.withTransaction(
          (driver) => {
            ({ replayed } = driver as SurrealTransactionDriver);
            return fn(driver);
          },
          options,
          context
        );
      } catch (error) {
        // A refusal after the conflict hides it, so the transaction is who says.
        if (reruns-- === 0 || !replayed?.conflicted) throw error;
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 20 * run)
      );
    }
  }

  protected override buildStatement(query: Sql): string {
    return namedStatement(query);
  }

  protected override createTransactionBoundDriver(
    tx: ReplayedTransaction,
    context: QueryExecutionContext
  ): SurrealTransactionDriver {
    return new SurrealTransactionDriver(this, tx, context);
  }

  protected async initClient(): Promise<Surreal> {
    const { url, namespace, database, authentication } = this.#options;
    if (!url)
      throw new ClientInitializationError(
        'Driver "surrealdb" needs a connected client or a url.',
        { meta: { driver: "surrealdb", operation: "configuration" } }
      );
    const client = new Surreal();
    await client.connect(url, {
      ...(namespace ? { namespace } : {}),
      ...(database ? { database } : {}),
      ...(authentication ? { authentication: { ...authentication } } : {}),
    });
    return client;
  }

  protected async closeClient(): Promise<void> {
    // A client handed in is the caller's.
    if (this.#options.client) return;
    await (this.client as Surreal | null)?.close();
  }

  protected async execute<T>(
    client: Surreal | ReplayedTransaction,
    statement: string,
    params: unknown[]
  ): Promise<QueryResult<T>> {
    const values = Object.fromEntries(
      params.map((value, index) => [`p${index + 1}`, value])
    );
    try {
      // What a statement holds ahead of itself is read with it, as one transaction.
      const stated = standsAlone(client, statement)
        ? `BEGIN; ${statement}; COMMIT;`
        : statement;
      // The SDK's client answers the same call.
      const answers = await (client as ReplayedTransaction).query<unknown[]>(
        stated,
        values
      );
      // What a statement holds ahead of itself answers first, and `COMMIT` last.
      const result = answers.at(stated.endsWith("; COMMIT;") ? -2 : -1);
      const rows = Array.isArray(result) ? result : [];
      return { rows: plain(rows) as T[], rowCount: rows.length };
    } catch (error) {
      throw refusal(error);
    }
  }

  protected executeRaw<T>(
    client: Surreal | ReplayedTransaction,
    statement: string,
    params: unknown[] | undefined,
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.execute<T>(client, statement, params ?? []);
  }

  /**
   * A migration statement led by `LET` is one transaction this driver opens for
   * it ({@link standsAlone}). Refused at its commit because another writer met
   * it there, it wrote nothing and answered no one: it runs again, as it would
   * have a moment later. A migration's rewrite of a table's rows is one, and
   * meets the server's own background writes to that table. That transaction
   * is the whole statement because a migration holds no `BEGIN`, `COMMIT` or
   * `CANCEL` (`statement-safety.ts`). A caller's raw statement can, and part of
   * it may have committed before the refusal, so it is never run again: it
   * fails with the conflict.
   *
   * One rerun is not enough: in #171's reproduction the background writes met
   * the rewrite in 40 of 150 first attempts, and nothing keeps them from
   * meeting a second one. The bound is the one a replayed transaction's commit
   * uses ({@link COMMITS}). This driver itself, never one bound to a
   * transaction, implements this, so a conflict inside a transaction stays
   * that transaction's.
   */
  async rerunRefusedCommit(
    statement: string,
    send: () => Promise<unknown>
  ): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send();
      } catch (error) {
        if (
          attempt === COMMITS ||
          !isConflict(error) ||
          !standsAlone(this.client, statement)
        )
          throw error;
      }
      // Two losers running again together would only meet again.
      await new Promise((resolve) =>
        setTimeout(resolve, Math.random() * 10 * attempt)
      );
    }
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return {
      isolationLevel: "snapshot-only",
      isolationLevelReason:
        "a SurrealDB transaction reads a snapshot, where two may each read what the other writes",
      timeout: true,
      maxWait: "acquisition",
    };
  }

  protected async transaction<T>(
    client: Surreal | ReplayedTransaction,
    fn: (tx: ReplayedTransaction) => Promise<T>,
    _context?: QueryExecutionContext,
    options?: DriverTransactionOptions
  ): Promise<T> {
    const transaction = await ReplayedTransaction.begin(
      client as Surreal,
      options?.maxWaitMs
    );
    let result: T;
    try {
      result = await fn(transaction);
    } catch (error) {
      await transaction.cancel().catch(() => undefined);
      throw error;
    }
    try {
      await transaction.commit();
    } catch (error) {
      throw refusal(error);
    }
    return result;
  }
}

export type SurrealClientConfig<C extends DriverConfig> = SurrealDriverOptions &
  C;

const SURREAL_CONFIG_KEYS: Record<keyof SurrealDriverOptions, true> = {
  client: true,
  url: true,
  namespace: true,
  database: true,
  authentication: true,
  rerunsOnConflict: true,
};

export function createClient<S extends Schema, C extends DriverConfig<S>>(
  config: SurrealClientConfig<C> &
    DriverConfig<S> &
    NoExtraDriverConfigKeys<C, SurrealDriverOptions, S>
): VibORMClient<{
  [P in keyof LinkedClientConfig<
    C & { driver: SurrealDriver }
  >]: LinkedClientConfig<C & { driver: SurrealDriver }>[P];
}> {
  refuseUnknownDriverConfigKeys(config, "surrealdb", SURREAL_CONFIG_KEYS);
  const { client, url, namespace, database, authentication, rerunsOnConflict } =
    config;
  return createClientFromDriverConfig<S, C, SurrealDriver>(
    config,
    new SurrealDriver({
      client,
      url,
      namespace,
      database,
      authentication,
      rerunsOnConflict,
    })
  );
}
