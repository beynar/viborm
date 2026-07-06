import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type { QueryContext } from "../../types";
import type { Effect, Probe, ProbeResult } from "./effects";
import type { IdentityExprs, WriteSymbol } from "./expr";

export interface Mode {
  readonly canObserveOwnWrites: boolean; // Live: true; Planned: false

  /** Axis A: lower a symbol into SQL for a consuming statement.
   *  Live: the captured JS literal via buildScalarSqlValue.
   *  Planned: batchRefs.read(...) via buildScalarSqlValue (already handles
   *  it, including the mandatory TEXT-round-trip cast-back). */
  resolveSymbol(
    ctx: QueryContext,
    model: Model<any>,
    field: string,
    sym: WriteSymbol
  ): Sql;

  /** True iff the symbol already has a concrete value (Live after capture).
   *  Used by the Probe Independence Rule (§6.2) and identity rebinding. */
  isResolved(sym: WriteSymbol): boolean;

  /** Axis B: run a deciding read.
   *  Live: now, on the tx driver (sees own writes; honors forUpdate); the
   *  returned guard realizes as a no-op (§5.1).
   *  Planned: now, on the base driver (committed state, plan time); the
   *  returned guard MUST be emitted and realizes as an assertion statement.
   *  Planned enforces the Probe Independence Rule (§6.2). */
  probe(ctx: QueryContext, p: Probe): Promise<ProbeResult>;

  /** The atomic scope: all-or-nothing + ordered + one connection. */
  readonly scope: AtomicScope;
}

export interface AtomicScope {
  run<T>(
    body: (emit: Emit, mode: Mode) => Promise<NestedWriteResult>
  ): Promise<T>;
}

/** The effect sink. Live: executes the effect immediately (capturing
 *  `produces` via RETURNING/lastInsertId/refetch — executeSimpleInsert's
 *  contract, including the translateRowToFieldNames choke point — and
 *  enforcing requireAffected via rowCount). Planned: lowers and appends
 *  (insert → [insertSql, ...storeLastInsertId per produced symbol];
 *  requireAffected → a preceding exists-assert; guard → adapter.assertions;
 *  update-with-computedPk → [updateSql, ...store(valueSql)]).
 *
 *  Returns the inserted row for an `insert` effect on the substrate that holds
 *  it (Live), so the interpreter can thread the top-level parent record into
 *  `NestedWriteResult.record` for a scalar-only result (§8.2). Planned defers
 *  every produced value and holds no record, so it returns `undefined`; other
 *  effect kinds return `undefined` in both modes. The record is captured
 *  structurally by the outermost `interpretCreate`, never inferred from model
 *  identity (self-referential FK creates would otherwise misattribute it). */
export type Emit = (
  effect: Effect
) => Promise<Record<string, unknown> | undefined>;

/** What the interpreter body returns to the scope: the final identity and
 *  the Prisma-parity result contract (§8.2/§8.3). */
export interface NestedWriteResult {
  readonly finalWhere: IdentityExprs; // post-update PK, possibly symbolic
  readonly refetch: boolean; // true iff select/include present
  readonly selectInclude?: Record<string, unknown>;
  /** Live mode already holds the record when refetch=false. */
  readonly record?: Readonly<Record<string, unknown>>;
}
