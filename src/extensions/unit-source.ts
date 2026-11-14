/**
 * A unit of real work, as a handler receives it, and what its producer
 * already holds about it. The runner keeps the producer's record beside the
 * unit; each fact word (`text`, `parameters`, `driver`, …) reads that record
 * when it is called. A fact nobody reads is never computed, and a program
 * that imports no word carries none of their code.
 */
import type {
  DriverIdentity,
  DriverIdentitySource,
} from "@drivers/driver-identity";
import type { BatchQuery, QueryExecutionContext } from "@drivers/types";
import type { Sql } from "@sql";

export type UnitKind =
  | "operation"
  | "statement"
  | "batch"
  | "transaction"
  | "savepoint"
  | "connection"
  | "cache";

export type CommitCertainty = "committed" | "may-have-committed";

/** What a handler receives: the kind of work and what it concerns. */
export interface Unit {
  readonly kind: UnitKind;
  readonly operation?: string;
  readonly model?: string;
}

/**
 * How the unit's child ended, as `next()` resolves it. Never the
 * application's result; the failure itself is read by `failure(unit)`.
 */
export interface UnitEnd {
  readonly status: "success" | "failure";
  /** Milliseconds from `next()` to the child's settlement. */
  readonly duration: number;
  /** Present where the child's work reached a commit. */
  readonly certainty?: CommitCertainty;
  /**
   * The child failed and its owner recovered (a `findUnique` batch's shared
   * read, whose callers each ran alone): the failure is not the call's.
   */
  readonly recovered?: true;
}

/**
 * One handler around a unit. `next()` lets the unit run; the child starts
 * only then, at most once, and must be called. What the handler throws, or a
 * promise it returns that rejects, fails the call; the child's own failure
 * fails it first.
 */
export type UnitHandler = (
  unit: Unit,
  next: () => Promise<UnitEnd>
) => unknown;

/** One cache decision of a logical execution. Never a key or a suffix. */
export interface CacheOutcome {
  readonly event: "bypass" | "hit" | "miss" | "revalidate";
  readonly status?: string | undefined;
  readonly at: number;
  readonly error?: unknown;
}

/** What a settled cache step adds: a get's result, or outcomes to present. */
export interface CacheCompletion {
  readonly result?: "hit" | "miss" | "stale";
  readonly outcomes?: readonly CacheOutcome[];
}

/** What the cache holds about one of its steps (`cacheFacts`). */
export interface CacheUnitSource {
  /** The cache backend, for get, set, invalidate, delete and clear. */
  readonly driver?: string;
  /** set: the entry's lifetime in milliseconds. */
  readonly ttl?: number;
  /** revalidate: the replayed read, a root operation of its own. */
  readonly read?: {
    readonly model: string;
    readonly operation: string;
    readonly driver: DriverIdentity | undefined;
  };
  readonly complete?: (
    failed: boolean,
    failure: unknown
  ) => CacheCompletion | undefined;
}

/** Runs one statement in the transaction a unit opened, and gives its rows. */
export type TransactionStatementRunner = (
  statement: Sql
) => Promise<readonly Record<string, unknown>[]>;

/**
 * The producer's record of one unit: references it already held, never a
 * fact computed for a reader that may not come.
 */
export interface UnitSource {
  readonly kind: UnitKind;
  readonly operation?: string | undefined;
  readonly model?: string | undefined;
  /** The trusted execution context: correlation, and a recovered read. */
  readonly context?: QueryExecutionContext | undefined;
  /** The driver doing the work, read only by `driver(unit)`. */
  readonly driver?: DriverIdentitySource | undefined;
  /** operation: the SQL name of the model. */
  readonly table?: string | undefined;
  /** statement: the rendered text sent, a native batch's texts joined. */
  readonly sql?: string | undefined;
  /** statement: the parameters sent, as the driver detached them. */
  readonly params?: readonly unknown[] | undefined;
  /** statement: a native batch's members, in order. */
  readonly batch?: readonly BatchQuery[] | undefined;
  /** statement under a rewriting unit: the statement before its rewrite. */
  readonly statement?: Sql | undefined;
  readonly cache?: CacheUnitSource | undefined;
  /** How sure the child's commit is, read once it settled. */
  readonly certainty?: (() => CommitCertainty | undefined) | undefined;
  /**
   * transaction: called by the producer once the transaction is open, with
   * what runs a statement in it; the body waits for what it returns.
   */
  opened?: (run: TransactionStatementRunner) => Promise<void> | undefined;
  /** transaction: `run(unit, sql)`, set by the runner. */
  run?: TransactionStatementRunner;
  /** Set by the runner once the child settled. */
  failed?: boolean;
  failure?: unknown;
}

const sources = new WeakMap<Unit, UnitSource>();

/** The producer's record of `unit`, or `undefined` for a unit it did not make. */
export const sourceOf = (unit: Unit): UnitSource | undefined =>
  sources.get(unit);

/** The unit a handler receives for `source`, kept beside it. */
export function unitOf(source: UnitSource): Unit {
  const { kind, operation, model } = source;
  const unit: Unit = {
    kind,
    ...(operation === undefined ? {} : { operation }),
    ...(model === undefined ? {} : { model }),
  };
  sources.set(unit, source);
  return unit;
}
