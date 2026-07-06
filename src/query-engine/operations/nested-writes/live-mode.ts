import type { AnyDriver } from "@drivers";
import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { buildScalarSqlValue } from "../../builders/values-builder";
import {
  createChildContext,
  getTableName,
  translateRowToFieldNames,
} from "../../context";
import { parseFindUniqueResult } from "../../result-flow";
import { type QueryContext, QueryEngineError } from "../../types";
import { buildFindUnique } from "../find-unique";
import {
  fetchRequiredUniqueRows,
  getCreateRefetchWhere,
} from "../mutation-returns";
import {
  lowerAssignments,
  lowerInsertManyRows,
  lowerInsertRow,
} from "./effect-lowering";
import type { Effect, Guard, Probe, ProbeResult } from "./effects";
import type { Expr, WriteSymbol } from "./expr";
import type { AtomicScope, Emit, Mode, NestedWriteResult } from "./mode";
import { buildSelectOneSql } from "./record-access";

/**
 * The interactive-transaction substrate (`canObserveOwnWrites: true`).
 *
 * A read issued mid-operation sees this operation's own uncommitted writes, so
 * branch decisions are made live, produced values are read back as JS literals,
 * and probe-backed guards realize as no-ops (§5.1). The whole operation runs
 * inside one flat `driver.withTransaction` scope (§8.2); recursion threads the
 * same `emit`, never a nested `withTransaction`.
 */
export class LiveMode implements Mode {
  readonly canObserveOwnWrites = true;
  readonly scope: AtomicScope;
  private readonly driver: AnyDriver;

  /** The root query context, bound once by the interpreter before scope.run. */
  private rootCtx: QueryContext | undefined;
  /** The active transaction driver for the current scope. */
  private tx: AnyDriver | undefined;
  /** Symbol id → captured concrete value (bound when an insert runs). */
  private readonly values = new Map<string, unknown>();
  /** Premises probe-established in this scope realize as no-op guards (§5.4). */
  private readonly probeEstablished = new WeakSet<Guard>();

  constructor(driver: AnyDriver) {
    this.driver = driver;
    this.scope = {
      run: <T>(
        body: (emit: Emit, mode: Mode) => Promise<NestedWriteResult>
      ): Promise<T> =>
        this.driver.withTransaction(async (txDriver) => {
          this.tx = txDriver;
          try {
            const result = await body(
              (effect) => this.runEffect(txDriver, effect),
              this
            );
            return await this.assembleResult<T>(txDriver, result);
          } finally {
            this.tx = undefined;
            this.values.clear();
          }
        }),
    };
  }

  /** Bound by the interpreter before scope.run so effect execution reuses the
   *  top-level QueryContext machinery (adapter, alias space, registry). */
  bindContext(rootCtx: QueryContext): void {
    this.rootCtx = rootCtx;
  }

  resolveSymbol(
    ctx: QueryContext,
    model: Model<any>,
    field: string,
    sym: WriteSymbol
  ): Sql {
    if (!this.values.has(sym.id)) {
      throw new QueryEngineError(
        `Live nested write consumed symbol '${sym.id}' (${sym.field}) before it was produced.`
      );
    }
    return buildScalarSqlValue(ctx, model, field, this.values.get(sym.id));
  }

  isResolved(sym: WriteSymbol): boolean {
    return this.values.has(sym.id);
  }

  async probe(ctx: QueryContext, p: Probe): Promise<ProbeResult> {
    const tx = this.requireTx();
    // `forUpdate` is only requested by the top-level upsert probe, which lands
    // at M6; the create family (M3) issues no locking probe, so a plain
    // select-one suffices here.
    const selectSql = buildSelectOneSql(ctx, p.model, p.where);
    const result = await tx._execute<Record<string, unknown>>(selectSql);
    const row = result.rows[0];

    if (!row) {
      if (p.required) {
        throw p.required.error();
      }
      return { found: false, guard: p.pin?.whenMissing };
    }

    const guard = p.pin?.whenFound;
    if (guard) {
      this.probeEstablished.add(guard);
    }
    return {
      found: true,
      record: translateRowToFieldNames(p.model, row),
      guard,
    };
  }

  // --- effect execution ----------------------------------------------------

  private async runEffect(
    tx: AnyDriver,
    effect: Effect
  ): Promise<Record<string, unknown> | undefined> {
    switch (effect.kind) {
      case "insert":
        return await this.runInsert(tx, effect);
      case "insertMany":
        await this.runInsertMany(tx, effect);
        return undefined;
      case "update":
        await this.runUpdate(tx, effect);
        return undefined;
      case "delete":
        await this.runDelete(tx, effect);
        return undefined;
      case "guard":
        await this.runGuard(tx, effect.guard);
        return undefined;
      default: {
        const exhaustive: never = effect;
        return exhaustive;
      }
    }
  }

  private async runInsert(
    tx: AnyDriver,
    effect: Extract<Effect, { kind: "insert" }>
  ): Promise<Record<string, unknown>> {
    const ctx = this.childCtx(effect.model);
    const { columns, values } = lowerInsertRow(
      ctx,
      this,
      effect.model,
      effect.data
    );
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    const insertSql = this.insertSql(
      ctx,
      table,
      columns,
      [values],
      effect.skipDuplicates
    );
    const record = await this.executeInsertReturning(
      tx,
      ctx,
      effect.model,
      insertSql,
      effect.data
    );
    for (const symbol of effect.produces) {
      this.values.set(symbol.id, record[symbol.field]);
    }
    // The inserted row is handed back to the interpreter; the outermost
    // `interpretCreate` keeps the top-level parent's row for a scalar-only
    // result (§8.2). No model-identity heuristic — a self-referential FK create
    // inserts a same-model child first and would otherwise claim the result.
    return record;
  }

  private async runInsertMany(
    tx: AnyDriver,
    effect: Extract<Effect, { kind: "insertMany" }>
  ): Promise<void> {
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
    const insertSql = this.insertSql(
      ctx,
      table,
      columns,
      values,
      effect.skipDuplicates
    );
    await tx._execute(insertSql);
  }

  private async runUpdate(
    tx: AnyDriver,
    effect: Extract<Effect, { kind: "update" }>
  ): Promise<void> {
    const ctx = this.childCtx(effect.model);
    const assignments = lowerAssignments(ctx, this, effect.model, effect.set);
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    const updateSql = ctx.adapter.mutations.update(
      table,
      sql.join(assignments, ", "),
      effect.where
    );
    const result = await tx._execute(updateSql);
    if (effect.requireAffected !== false && result.rowCount === 0) {
      throw effect.requireAffected.error();
    }
    // computedPk symbols would bind here at M5; M3 emits none.
  }

  private async runDelete(
    tx: AnyDriver,
    effect: Extract<Effect, { kind: "delete" }>
  ): Promise<void> {
    const ctx = this.childCtx(effect.model);
    const table = ctx.adapter.identifiers.escape(getTableName(effect.model));
    const deleteSql = ctx.adapter.mutations.delete(table, effect.where);
    const result = await tx._execute(deleteSql);
    if (effect.requireAffected !== false && result.rowCount === 0) {
      throw effect.requireAffected.error();
    }
  }

  private async runGuard(tx: AnyDriver, guard: Guard): Promise<void> {
    // Probe-established premises are serialized/locked by the open transaction,
    // so their guard is a no-op (§5.1). A standalone premise executes as a
    // SELECT-then-throw so live mode never silently drops it (§5.4 / S1).
    if (this.probeEstablished.has(guard)) {
      return;
    }
    const ctx = this.childCtx(guard.premise.model);
    const selectSql = buildSelectOneSql(
      ctx,
      guard.premise.model,
      guard.premise.where
    );
    const result = await tx._execute(selectSql);
    const exists = result.rows.length > 0;
    const holds = guard.premise.kind === "exists" ? exists : !exists;
    if (!holds) {
      throw guard.failure.error();
    }
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

  private async executeInsertReturning(
    tx: AnyDriver,
    ctx: QueryContext,
    model: Model<any>,
    insertSql: Sql,
    data: Readonly<Record<string, Expr>>
  ): Promise<Record<string, unknown>> {
    const modelName = model["~"]?.names?.ts ?? getTableName(model);
    const returningSql = ctx.adapter.mutations.returning(sql`*`);
    const hasReturning = returningSql.strings.join("").trim() !== "";

    if (hasReturning) {
      const finalSql = sql`${insertSql} ${returningSql}`;
      const result = await tx._execute<Record<string, unknown>>(finalSql);
      const row = result.rows[0];
      if (!row) {
        throw new QueryEngineError(
          `Insert did not return a record for model '${modelName}'.`
        );
      }
      return translateRowToFieldNames(model, row);
    }

    const insertResult = await tx._execute(insertSql);
    const where = await getCreateRefetchWhere(
      tx,
      ctx,
      literalProjection(data),
      modelName,
      insertResult.insertId
    );
    const rows = await fetchRequiredUniqueRows(
      tx,
      ctx,
      { where },
      "create",
      modelName
    );
    return rows[0]!;
  }

  private async assembleResult<T>(
    tx: AnyDriver,
    result: NestedWriteResult
  ): Promise<T> {
    if (!result.refetch) {
      const record = result.record;
      if (!record) {
        throw new QueryEngineError(
          "Live nested write produced no record for a scalar-only result."
        );
      }
      return record as T;
    }

    const ctx = this.rootCtxOrThrow();
    const where = this.resolveIdentity(result.finalWhere);
    const refetchSql = buildFindUnique(ctx, {
      where,
      select: result.selectInclude?.select as
        | Record<string, unknown>
        | undefined,
      include: result.selectInclude?.include as
        | Record<string, unknown>
        | undefined,
    } as { where: Record<string, unknown> });
    const refetchResult =
      await tx._execute<Record<string, unknown>>(refetchSql);
    return parseFindUniqueResult<T>(ctx, refetchResult.rows);
  }

  private resolveIdentity(
    identity: NestedWriteResult["finalWhere"]
  ): Record<string, unknown> {
    const where: Record<string, unknown> = {};
    for (const [field, expr] of Object.entries(identity)) {
      if (expr.kind === "lit") {
        where[field] = expr.value;
      } else if (expr.kind === "sym") {
        where[field] = this.values.get(expr.sym.id);
      } else {
        throw new QueryEngineError(
          `Live nested write cannot refetch by a subquery identity on field '${field}'.`
        );
      }
    }
    return where;
  }

  private childCtx(model: Model<any>): QueryContext {
    const root = this.rootCtxOrThrow();
    if (model === root.model) {
      return root;
    }
    return createChildContext(root, model, root.nextAlias());
  }

  private rootCtxOrThrow(): QueryContext {
    if (!this.rootCtx) {
      throw new QueryEngineError(
        "LiveMode was invoked before its query context was bound."
      );
    }
    return this.rootCtx;
  }

  private requireTx(): AnyDriver {
    if (!this.tx) {
      throw new QueryEngineError(
        "LiveMode.probe called outside an atomic scope."
      );
    }
    return this.tx;
  }
}

function literalProjection(
  data: Readonly<Record<string, Expr>>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [field, expr] of Object.entries(data)) {
    if (expr.kind === "lit") {
      out[field] = expr.value;
    }
  }
  return out;
}
