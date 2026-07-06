import type { AnyDriver } from "@drivers";
import {
  isVibORMError,
  NestedWriteAssertionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { buildPrimaryKeyWhereUnique } from "../../builders/correlation-utils";
import { buildScalarSqlValue } from "../../builders/values-builder";
import {
  createChildContext,
  getTableName,
  translateRowToFieldNames,
} from "../../context";
import { parseFindUniqueResult } from "../../result-flow";
import {
  type BatchPreparationContext,
  NestedWriteError,
  type PreparedBatchOperation,
  type QueryContext,
  QueryEngineError,
} from "../../types";
import { buildFindUnique } from "../find-unique";
import {
  type BatchValueRef,
  collectPlanStatements,
  createPlanState,
  type PlanState,
} from "./batch-references";
import {
  lowerInsertManyRows,
  lowerInsertRow,
  lowerUpdateSet,
} from "./effect-lowering";
import {
  type Effect,
  type Guard,
  type GuardFailure,
  type Probe,
  type ProbeResult,
  surfaceGuardFailure,
} from "./effects";
import type { Expr, WriteSymbol } from "./expr";
import type { AtomicScope, Emit, Mode, NestedWriteResult } from "./mode";
import { buildSelectOneSql } from "./record-access";

/**
 * A premise registered in the plan-time side table (§7.3): the assertion's
 * position in the plan, the premise SQL to re-evaluate on abort, and the typed
 * error it stands for. Populated as guards and requireAffected-asserts are
 * appended; consulted only on the error path by the attribution ladder.
 */
interface RegisteredGuard {
  /** Index into the full `_executeBatch` statement window (setup + operation).
   *  Feeds index attribution (§7.3 step 2) when a driver reports the failing
   *  statement position. */
  readonly index: number;
  readonly premise: Guard["premise"];
  readonly failure: GuardFailure;
  /** The child context the premise SELECT re-executes against (its adapter,
   *  identifiers, alias namespace). */
  readonly ctx: QueryContext;
}

/**
 * The batch-only substrate (`canObserveOwnWrites: false`) for D1 / Neon-HTTP.
 *
 * A read cannot see this operation's own uncommitted writes, so branch
 * decisions are made at plan time against committed state, produced values are
 * deferred through the scratch table (`batchRefs.store`/`read`), and
 * probe-backed premises are pinned by SQL assertions inside the atomic unit
 * (§8.3). The `PlanState` is shared across the operations of one
 * `$transaction([...])` via `BatchPreparationContext.nestedWriteState`, so
 * value-ref namespaces and setup/cleanup stay monotonic (map-oracle §B.2/§B.3).
 */
export class PlannedMode implements Mode {
  readonly canObserveOwnWrites = false;
  readonly scope: AtomicScope;
  private readonly driver: AnyDriver;
  private readonly shared: BatchPreparationContext | undefined;

  /** The root query context, bound once by the interpreter before scope.run. */
  private rootCtx: QueryContext | undefined;
  /** The plan being appended to during the current scope. */
  private state: PlanState | undefined;
  /** Symbol id → the deferred value ref that resolves it at read time. */
  private readonly symbolRefs = new Map<string, BatchValueRef>();
  /** The abort-attribution side table (§7.3): statement position → the typed
   *  error its premise stands for. Populated as guards / requireAffected-asserts
   *  are appended during the current scope; consulted only on the error path. */
  private readonly registeredGuards: RegisteredGuard[] = [];

  constructor(driver: AnyDriver, shared?: BatchPreparationContext) {
    this.driver = driver;
    this.shared = shared;
    this.scope = {
      run: <T>(
        body: (emit: Emit, mode: Mode) => Promise<NestedWriteResult>
      ): Promise<T> => this.runScope<T>(body),
    };
  }

  /** True iff this planned scope shares its PlanState across the operations of
   *  one `$transaction([...])` (map-oracle §B.2/§B.3). */
  get isShared(): boolean {
    return this.shared !== undefined;
  }

  /** Bound by the interpreter before scope.run. */
  bindContext(rootCtx: QueryContext): void {
    this.rootCtx = rootCtx;
  }

  resolveSymbol(
    ctx: QueryContext,
    model: Model<any>,
    field: string,
    sym: WriteSymbol
  ): Sql {
    const ref = this.symbolRefs.get(sym.id);
    if (!ref) {
      throw new QueryEngineError(
        `Planned nested write consumed symbol '${sym.id}' (${sym.field}) before it was produced.`
      );
    }
    // buildScalarSqlValue lowers a BatchValueRef through batchRefs.read with the
    // mandatory TEXT round-trip cast-back (castBatchRefValue).
    return buildScalarSqlValue(ctx, model, field, ref);
  }

  isResolved(sym: WriteSymbol): boolean {
    return this.symbolRefs.has(sym.id);
  }

  symbolCarrier(sym: WriteSymbol): unknown {
    const ref = this.symbolRefs.get(sym.id);
    if (!ref) {
      throw new QueryEngineError(
        `Planned nested write read symbol '${sym.id}' (${sym.field}) before it was produced.`
      );
    }
    // The BatchValueRef carrier lowers through buildScalarSqlValue inside the
    // shared FK builders (batchRefs.read with the TEXT round-trip cast-back).
    return ref;
  }

  async probe(ctx: QueryContext, p: Probe): Promise<ProbeResult> {
    // The Probe Independence Rule (§6.2): a plan-time read must not depend on
    // this operation's own writes. `p.where` is adapter-built Sql; if it
    // embedded a batchRefs.read (an unresolved symbol) it would read the empty
    // scratch table and mis-decide. The M3 create family never builds such a
    // probe (connect targets are literal/committed), but the guard is enforced
    // structurally: symbol-dependent probes are rejected at the legality gate.
    const selectSql = buildSelectOneSql(ctx, p.model, p.where);
    const result = await this.baseExecute<Record<string, unknown>>(selectSql);
    const row = result.rows[0];

    if (!row) {
      if (p.required) {
        throw surfaceGuardFailure(p.required);
      }
      return { found: false, guard: p.pin?.whenMissing };
    }
    return {
      found: true,
      record: translateRowToFieldNames(p.model, row),
      guard: p.pin?.whenFound,
    };
  }

  async probeRows(
    ctx: QueryContext,
    model: Model<any>,
    where: Sql,
    columns: Sql
  ): Promise<Record<string, unknown>[]> {
    // Reads committed state on the base driver at plan time (the m2m connected-PK
    // set is materialized here — §9). Its staleness is closed by the
    // symmetric-difference guards the interpreter emits, not by this read.
    const selectSql = sql.join(
      [
        ctx.adapter.clauses.select(columns),
        ctx.adapter.clauses.from(
          ctx.adapter.identifiers.escape(getTableName(model))
        ),
        ctx.adapter.clauses.where(where),
      ],
      " "
    );
    const result = await this.baseExecute<Record<string, unknown>>(selectSql);
    return result.rows;
  }

  // --- scope ----------------------------------------------------------------

  private async runScope<T>(
    body: (emit: Emit, mode: Mode) => Promise<NestedWriteResult>
  ): Promise<T> {
    const rootCtx = this.rootCtxOrThrow();
    const shared = this.getSharedState(rootCtx);
    const state = shared ?? createPlanState(rootCtx);
    this.state = state;
    const statementStart = state.statements.length;

    const result = await body((effect) => this.appendEffect(effect), this);

    // Append the final result read (I10 window math preserved): findUnique by
    // the resolved final identity, select/include applied.
    state.statements.push(
      buildFindUnique(rootCtx, {
        where: this.lowerIdentityToWhere(rootCtx, result.finalWhere),
        select: result.selectInclude?.select as
          | Record<string, unknown>
          | undefined,
        include: result.selectInclude?.include as
          | Record<string, unknown>
          | undefined,
      } as { where: Record<string, unknown> })
    );

    const operationStatements = state.statements.slice(statementStart);
    const resultIndex = operationStatements.length - 1;
    const parse = (results: { rows?: unknown[] }[]): T =>
      parseFindUniqueResult<T>(
        rootCtx,
        (results[resultIndex]?.rows as Record<string, unknown>[]) ?? []
      );

    this.state = undefined;
    this.symbolRefs.clear();

    if (shared) {
      // Shared $transaction([...]) path: return the prepared batch operation so
      // the caller collects and executes all operations together. Attribution
      // for the combined batch is the caller's concern; the side table only
      // spans a single-operation atomic unit, so it is dropped here.
      this.registeredGuards.length = 0;
      const prepared: PreparedBatchOperation<T> = {
        queries: operationStatements.map((statement) =>
          this.prepare(statement)
        ),
        setupQueries: state.setupStatements.map((statement) =>
          this.prepare(statement)
        ),
        cleanupQueries: state.cleanupStatements.map((statement) =>
          this.prepare(statement)
        ),
        parseResult: parse,
      };
      return prepared as unknown as T;
    }

    // Single-operation path: execute the whole plan as one atomic batch. On
    // abort, the attribution ladder (§7.3) maps the failure back to the same
    // typed error live mode would have thrown.
    const setupCount = state.setupStatements.length;
    const guards = this.registeredGuards.slice();
    this.registeredGuards.length = 0;
    const statements = collectPlanStatements(state);
    try {
      const results = await this.driver._executeBatch(
        statements.map((statement) => this.prepare(statement))
      );
      // The result window skips the setup statements (I10).
      return parse(results.slice(setupCount));
    } catch (error) {
      throw await this.attributeAbort(error, guards, setupCount);
    }
  }

  // --- abort attribution (§7.3) --------------------------------------------

  /**
   * The abort-attribution ladder (§7.3, M7). When the atomic batch rejects, map
   * the failure back to the same typed error live mode would have thrown, so
   * both modes surface one message for correlation/orphan/target-missing/
   * existence failures (D1 closed). The ladder is error-path only.
   *
   * 1. Pass-through: `UniqueConstraintError` / DEADLOCK / SERIALIZATION are the
   *    write-race signals (Pin Rule, map-oracle D7) — rethrown unchanged so the
   *    retry wrapper classifies them.
   * 2. Index attribution: if the driver reports the failing statement index,
   *    map it through the side table and throw that premise's typed error.
   * 3. Post-hoc re-probe: otherwise re-evaluate registered premises read-only,
   *    in order, against current state; the first violated premise's typed
   *    error is thrown. Symbol-embedded premises (scratch table gone after
   *    rollback) throw on re-execution and are skipped (scope limit, §7.3).
   * 4. Typed fallback: if nothing attributes, throw a generic-but-typed
   *    NestedWriteError carrying the historical assertion message and the
   *    NESTED_WRITE_ASSERTION_FAILED code, non-raceable (step-4 floor).
   */
  private async attributeAbort(
    error: unknown,
    guards: readonly RegisteredGuard[],
    setupCount: number
  ): Promise<unknown> {
    // Step 1 — pass-through the race signals unchanged.
    if (isWriteRaceSignal(error)) {
      return error;
    }
    // Only an assertion abort is a premise failure this ladder attributes.
    // Any other error (a real FK/NOT-NULL violation, a driver fault) is not a
    // guarded premise and is rethrown unchanged.
    if (!(error instanceof NestedWriteAssertionError)) {
      return error;
    }

    // Step 2 — index attribution when the driver reports the failing position.
    const failingIndex = readFailingStatementIndex(error);
    if (failingIndex !== undefined) {
      const operationIndex = failingIndex - setupCount;
      const hit = guards.find((guard) => guard.index === operationIndex);
      if (hit) {
        return surfaceGuardFailure(hit.failure);
      }
    }

    // Step 3 — post-hoc re-probe of each registered premise, in order.
    for (const guard of guards) {
      const violated = await this.premiseViolated(guard);
      if (violated) {
        return surfaceGuardFailure(guard.failure);
      }
    }

    // Step 4 — typed fallback (the floor): state moved on between abort and
    // re-probe, or only symbolic premises remain. A typed NestedWriteError with
    // the historical assertion message, non-raceable so the retry never loops on
    // it (§7.4). Preserve the original abort as cause.
    return new NestedWriteError(
      "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.",
      "",
      {
        code: VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
        cause: error instanceof Error ? error : undefined,
      }
    );
  }

  /** Re-evaluate one registered premise read-only against current committed
   *  state. Returns true iff the premise no longer holds (an `exists` premise
   *  whose row is gone; a `notExists` premise whose row is present). A premise
   *  that embeds a batch-ref subquery can no longer be evaluated after abort +
   *  rollback (the scratch table is gone) — its SELECT throws and we treat it as
   *  un-attributable (returns false), falling through to the next premise. */
  private async premiseViolated(guard: RegisteredGuard): Promise<boolean> {
    const selectOne = this.selectOneOf(
      guard.ctx,
      guard.premise.model,
      guard.premise.where
    );
    let rowPresent: boolean;
    try {
      const result = await this.baseExecute<Record<string, unknown>>(selectOne);
      rowPresent = result.rows.length > 0;
    } catch {
      return false;
    }
    return guard.premise.kind === "exists" ? !rowPresent : rowPresent;
  }

  // --- effect appending -----------------------------------------------------

  private appendEffect(
    effect: Effect
  ): Promise<Record<string, unknown> | undefined> {
    const state = this.stateOrThrow();
    switch (effect.kind) {
      case "insert":
        this.appendInsert(state, effect);
        break;
      case "insertMany":
        this.appendInsertMany(state, effect);
        break;
      case "update":
        this.appendUpdate(state, effect);
        break;
      case "delete":
        this.appendDelete(state, effect);
        break;
      case "junction":
        // A junction DML statement is fully lowered by the shared m2m builders
        // (target/parent values already resolved to literals or batchRefs.read
        // subqueries); append it verbatim (§9 m2m rows).
        state.statements.push(effect.statement);
        break;
      case "guard":
        this.appendGuard(state, effect.guard);
        break;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
    // Planned mode defers every produced value and holds no record; the
    // scalar-only result is refetched by the final identity (§8.3).
    return Promise.resolve(undefined);
  }

  private appendInsert(
    state: PlanState,
    effect: Extract<Effect, { kind: "insert" }>
  ): void {
    const ctx = this.childCtx(effect.model);
    const { columns, values } = lowerInsertRow(
      ctx,
      this,
      effect.model,
      effect.data
    );
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    state.statements.push(
      this.insertSql(ctx, table, columns, [values], effect.skipDuplicates)
    );
    // Capture produced symbols atomically after the insert (storeLastInsertId
    // ordering law, §5.4): one append, nothing can interleave.
    for (const symbol of effect.produces) {
      const ref = state.references.allocateValueRef();
      this.symbolRefs.set(symbol.id, ref);
      state.statements.push(
        ctx.adapter.batchRefs.storeLastInsertId(ref.batchId, ref.key)
      );
    }
  }

  private appendInsertMany(
    state: PlanState,
    effect: Extract<Effect, { kind: "insertMany" }>
  ): void {
    if (effect.rows.length === 0) {
      return;
    }
    const ctx = this.childCtx(effect.model);
    const { columns, values } = lowerInsertManyRows(
      ctx,
      this,
      effect.model,
      effect.rows
    );
    if (columns.length === 0) {
      return;
    }
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    state.statements.push(
      this.insertSql(ctx, table, columns, values, effect.skipDuplicates)
    );
  }

  private appendUpdate(
    state: PlanState,
    effect: Extract<Effect, { kind: "update" }>
  ): void {
    const ctx = this.childCtx(effect.model);
    // A correlated update must hit ≥1 row: a batch cannot observe rowCount
    // mid-list, so its requireAffected is pinned by a PRECEDING exists-assert
    // (§5.1 write-coupled premise).
    if (effect.requireAffected !== false) {
      this.registerGuard(
        state,
        ctx,
        { kind: "exists", model: effect.model, where: effect.where },
        effect.requireAffected
      );
      state.statements.push(
        ctx.adapter.assertions.exists(
          this.selectOneOf(ctx, effect.model, effect.where)
        )
      );
    }
    const setSql = lowerUpdateSet(ctx, this, effect);
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    state.statements.push(
      ctx.adapter.mutations.update(table, setSql, effect.where)
    );
    // Capture computedPk symbols (PK arithmetic) atomically after the update:
    // the DB computes the new PK, and store(valueSql) records it for downstream
    // reads. The valueSql is a constant arithmetic expression over the known
    // before-value, so storing it matches the value the UPDATE just wrote.
    for (const symbol of effect.produces) {
      if (symbol.origin.kind === "computedPk") {
        const ref = state.references.allocateValueRef();
        this.symbolRefs.set(symbol.id, ref);
        state.statements.push(
          ctx.adapter.batchRefs.store(
            ref.batchId,
            ref.key,
            symbol.origin.valueSql
          )
        );
      }
    }
  }

  private appendDelete(
    state: PlanState,
    effect: Extract<Effect, { kind: "delete" }>
  ): void {
    const ctx = this.childCtx(effect.model);
    if (effect.requireAffected !== false) {
      this.registerGuard(
        state,
        ctx,
        { kind: "exists", model: effect.model, where: effect.where },
        effect.requireAffected
      );
      state.statements.push(
        ctx.adapter.assertions.exists(
          this.selectOneOf(ctx, effect.model, effect.where)
        )
      );
    }
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    state.statements.push(ctx.adapter.mutations.delete(table, effect.where));
  }

  private appendGuard(state: PlanState, guard: Guard): void {
    const ctx = this.childCtx(guard.premise.model);
    this.registerGuard(state, ctx, guard.premise, guard.failure);
    const selectOne = this.selectOneOf(
      ctx,
      guard.premise.model,
      guard.premise.where
    );
    state.statements.push(
      guard.premise.kind === "exists"
        ? ctx.adapter.assertions.exists(selectOne)
        : ctx.adapter.assertions.notExists(selectOne)
    );
  }

  /** Record a premise in the abort-attribution side table (§7.3). The recorded
   *  index is the position the assertion statement will occupy in the FULL
   *  `_executeBatch` window (setup statements are prepended at execution, so the
   *  operation-relative position is offset by the setup count at ladder time). */
  private registerGuard(
    state: PlanState,
    ctx: QueryContext,
    premise: Guard["premise"],
    failure: GuardFailure
  ): void {
    this.registeredGuards.push({
      index: state.statements.length,
      premise,
      failure,
      ctx,
    });
  }

  // --- helpers -------------------------------------------------------------

  private insertSql(
    ctx: QueryContext,
    table: Sql,
    columns: string[],
    values: Sql[][],
    skipDuplicates: boolean | undefined
  ): Sql {
    if (!skipDuplicates) {
      return ctx.adapter.mutations.insert(table, columns, values);
    }
    const { prefix, suffix } = ctx.adapter.mutations.skipDuplicates();
    return sql`${ctx.adapter.mutations.insert(table, columns, values, prefix)} ${suffix}`;
  }

  private selectOneOf(ctx: QueryContext, model: Model<any>, where: Sql): Sql {
    return sql.join(
      [
        ctx.adapter.clauses.select(sql`1`),
        ctx.adapter.clauses.from(
          ctx.adapter.identifiers.escape(getTableName(model))
        ),
        ctx.adapter.clauses.where(where),
        ctx.adapter.clauses.limit(ctx.adapter.literals.value(1)),
      ],
      " "
    );
  }

  private lowerIdentityToWhere(
    ctx: QueryContext,
    identity: NestedWriteResult["finalWhere"]
  ): Record<string, unknown> {
    // The final identity may carry a deferred symbol (generated PK). Lower each
    // component into the value the findUnique where embeds: a literal, a
    // pre-built subquery Sql, or a batchRefs.read for a symbol.
    const values: Record<string, unknown> = {};
    for (const [field, expr] of Object.entries(identity)) {
      values[field] = this.identityComponent(expr);
    }
    return buildPrimaryKeyWhereUnique(ctx.model, values);
  }

  private identityComponent(expr: Expr): unknown {
    switch (expr.kind) {
      case "lit":
        return expr.value;
      case "sql":
        return expr.sql;
      case "sym": {
        const ref = this.symbolRefs.get(expr.sym.id);
        if (!ref) {
          throw new QueryEngineError(
            `Planned nested write cannot build a final identity for unresolved symbol '${expr.sym.id}'.`
          );
        }
        // The ref lowers to batchRefs.read inside buildFindUnique's where.
        return ref;
      }
      default: {
        const exhaustive: never = expr;
        return exhaustive;
      }
    }
  }

  private childCtx(model: Model<any>): QueryContext {
    const root = this.rootCtxOrThrow();
    if (model === root.model) {
      return root;
    }
    return createChildContext(root, model, root.nextAlias());
  }

  private getSharedState(ctx: QueryContext): PlanState | undefined {
    if (!this.shared) {
      return undefined;
    }
    if (this.shared.nestedWriteState) {
      if (!isPlanState(this.shared.nestedWriteState)) {
        throw new QueryEngineError(
          "Invalid nested write batch preparation context."
        );
      }
      return this.shared.nestedWriteState;
    }
    const created = createPlanState(ctx);
    this.shared.nestedWriteState = created;
    return created;
  }

  private prepare(statement: Sql): { sql: string; params: unknown[] } {
    const prepared = this.driver._prepare(statement);
    return { sql: prepared.sql, params: prepared.params ?? [] };
  }

  private baseExecute<T>(query: Sql): Promise<{ rows: T[] }> {
    return this.driver._execute<T>(query);
  }

  private rootCtxOrThrow(): QueryContext {
    if (!this.rootCtx) {
      throw new QueryEngineError(
        "PlannedMode was invoked before its query context was bound."
      );
    }
    return this.rootCtx;
  }

  private stateOrThrow(): PlanState {
    if (!this.state) {
      throw new QueryEngineError(
        "PlannedMode effect appended outside an atomic scope."
      );
    }
    return this.state;
  }
}

function isPlanState(value: unknown): value is PlanState {
  return (
    value !== null &&
    typeof value === "object" &&
    "batchId" in value &&
    "statements" in value &&
    "setupStatements" in value &&
    "cleanupStatements" in value &&
    "registerProducedPrimaryKeyRef" in value
  );
}

/** The write-race signals that must pass through the attribution ladder
 *  unchanged so the retry wrapper classifies them (§7.3 step 1, Pin Rule 2). */
function isWriteRaceSignal(error: unknown): boolean {
  if (error instanceof UniqueConstraintError) {
    return true;
  }
  return (
    isVibORMError(error) &&
    (error.code === VibORMErrorCode.DEADLOCK ||
      error.code === VibORMErrorCode.SERIALIZATION_FAILURE)
  );
}

/** Best-effort index attribution (§7.3 step 2): read a failing statement index
 *  off the abort error's meta if the driver surfaced one. The base
 *  `_executeBatch` contract does not report a position, so this is undefined for
 *  the current drivers and the ladder falls through to the re-probe step; the
 *  hook exists for a driver that does report one. */
function readFailingStatementIndex(error: unknown): number | undefined {
  if (!isVibORMError(error)) {
    return undefined;
  }
  const candidate = error.meta.statementIndex;
  return typeof candidate === "number" && Number.isInteger(candidate)
    ? candidate
    : undefined;
}
