/**
 * A unit of real work, as a handler receives it, and what its producer
 * already holds about it. The runner keeps the producer's record beside the
 * unit; each unit word (`text`, `parameters`, `driver`, …) reads that record
 * when it is called. A fact nobody reads is never computed, and a program
 * that imports no word carries none of their code.
 */
import type { DriverIdentitySource } from "@drivers/driver-identity";
import type { BatchQuery, QueryExecutionContext } from "@drivers/types";
import type { Sql } from "@sql";
import type { UnitContext, UnitKind, UnitOutcome } from "./contract";
import { CALL } from "./origin";

export type { UnitKind } from "./contract";
export type Unit = UnitContext;
export type UnitEnd = UnitOutcome;
export type CommitCertainty = "committed" | "may-have-committed";

/**
 * One handler around a unit. `next()` lets the unit run; the child starts
 * only then, at most once, and must be called. What the handler throws, or a
 * promise it returns that rejects, fails the call; the child's own failure
 * fails it first.
 */
export type UnitHandler = (
  unit: Unit,
  next: (sql?: Sql) => Promise<UnitEnd>
) => unknown;

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
  /** The trusted execution context: the chain, correlation, a recovered read. */
  readonly context?: QueryExecutionContext | undefined;
  /** operation: the object a call's two moments share (`note(run, …)`). */
  readonly call?: object | undefined;
  /** The driver doing the work, read only by `driver(unit)`. */
  readonly driver?: DriverIdentitySource | undefined;
  /** operation: the SQL name of the model. */
  readonly table?: string | undefined;
  /** statement: the rendered text sent, a native batch's texts joined. */
  readonly sql?: string | undefined;
  /** statement: the parameters sent, as the driver detached them. */
  readonly params?: readonly unknown[] | undefined;
  /**
   * statement: the diagnostic snapshot of `params` the driver took (its
   * empty constant when it took none): what `parameters(u)` reads.
   */
  readonly shown?: readonly unknown[] | undefined;
  /** statement: a native batch's members, in order. */
  readonly batch?: readonly BatchQuery[] | undefined;
  /**
   * A logical statement under rewriting units: the statement as the earlier
   * ones left it (what `next(sql)` hands on replaces it).
   */
  statement?: Sql | undefined;
  /** How sure the child's commit is, read once it settled. */
  readonly certainty?: (() => CommitCertainty | undefined) | undefined;
  /** What extensions noted on the unit (`note`), in order. */
  notes?: unknown[];
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
  /**
   * The instant the child settled, read by the innermost layer's end: an
   * outer layer's end comes after the inner handlers continued, and still
   * reports the child's instant.
   */
  settledAt?: number;
}

const sources = new WeakMap<object, UnitSource>();
/** A running operation unit, by its call and by its execution context. */
const operations = new WeakMap<object, UnitSource>();

/** The producer's record of `unit`, or `undefined` for a unit it did not make. */
export const sourceOf = (unit: object): UnitSource | undefined =>
  sources.get(unit);

/** The unit a handler receives for `source`, kept beside it. */
export function unitOf(source: UnitSource): Unit {
  const unit: Unit = {
    kind: source.kind,
    model: source.model,
    operation: source.operation,
  };
  sources.set(unit, source);
  source.notes ??= [];
  if (source.kind === "operation") {
    if (source.call !== undefined) operations.set(source.call, source);
    if (source.context !== undefined) operations.set(source.context, source);
  }
  return unit;
}

/**
 * The unit `origin` stands for: a unit a handler received or `work` made, the
 * operation unit of a call's `run`, or that of an execution context.
 */
export function originOf(origin: object): UnitSource | undefined {
  const call: unknown = CALL in origin ? Reflect.get(origin, CALL) : undefined;
  return (
    sources.get(origin) ??
    (typeof call === "object" && call !== null
      ? operations.get(call)
      : operations.get(origin))
  );
}
