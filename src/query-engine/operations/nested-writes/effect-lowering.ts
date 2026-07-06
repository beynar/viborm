import type { Model } from "@schema/model";
import { type Sql, sql } from "@sql";
import { buildSet } from "../../builders/set-builder";
import { buildScalarSqlValue } from "../../builders/values-builder";
import { createChildContext, getColumnName } from "../../context";
import type { QueryContext } from "../../types";
import type { Effect } from "./effects";
import type { Expr } from "./expr";
import type { Mode } from "./mode";

/**
 * Substrate-mechanical lowering shared by both modes (§8.4): turn an `Expr`
 * into the `Sql` value a statement embeds. This carries NO relation, step, or
 * branch decision — it consults `buildScalarSqlValue` (the one value leaf,
 * §0.1 Axis A) and the mode's `resolveSymbol`. Kept out of the mode files so
 * neither imports the interpreter, but importable by them because it is pure
 * lowering.
 */
export function lowerExpr(
  ctx: QueryContext,
  mode: Mode,
  model: Model<any>,
  field: string,
  expr: Expr
): Sql {
  switch (expr.kind) {
    case "lit":
      // buildScalarSqlValue lowers a literal (null included) through the
      // adapter, honoring array/json/datetime dialect serialization.
      return buildScalarSqlValue(ctx, model, field, expr.value);
    case "sql":
      // A pre-built fragment (connect target-PK subquery) passes through.
      return buildScalarSqlValue(ctx, model, field, expr.sql);
    case "sym":
      // Live: the captured JS literal. Planned: batchRefs.read(...) with the
      // mandatory TEXT round-trip cast-back — both via buildScalarSqlValue.
      return mode.resolveSymbol(ctx, model, field, expr.sym);
    default: {
      const exhaustive: never = expr;
      return exhaustive;
    }
  }
}

/**
 * Lower an insert's `data` (field → Expr) into the (columns, valuesRow) pair
 * `adapter.mutations.insert` consumes. Columns are actual DB column names via
 * `getColumnName` (map() overrides honored). Order is stable: one column per
 * present field, one value per column.
 */
export function lowerInsertRow(
  ctx: QueryContext,
  mode: Mode,
  model: Model<any>,
  data: Readonly<Record<string, Expr>>
): { columns: string[]; values: Sql[] } {
  const columns: string[] = [];
  const values: Sql[] = [];
  for (const field of Object.keys(data)) {
    columns.push(getColumnName(model, field));
    values.push(lowerExpr(ctx, mode, model, field, data[field]!));
  }
  return { columns, values };
}

/**
 * Lower an insertMany's rows (each field → Expr) into the (columns, valueRows)
 * pair. Columns are the union of fields present across all rows; a row missing
 * a column contributes `NULL` for it, matching `buildValues`' union semantics.
 */
export function lowerInsertManyRows(
  ctx: QueryContext,
  mode: Mode,
  model: Model<any>,
  rows: readonly Readonly<Record<string, Expr>>[]
): { columns: string[]; values: Sql[][] } {
  const fieldSet = new Set<string>();
  for (const row of rows) {
    for (const field of Object.keys(row)) {
      fieldSet.add(field);
    }
  }
  const fields = Array.from(fieldSet);
  const columns = fields.map((field) => getColumnName(model, field));
  const values: Sql[][] = rows.map((row) =>
    fields.map((field) => {
      const expr = row[field];
      return expr === undefined
        ? ctx.adapter.literals.null()
        : lowerExpr(ctx, mode, model, field, expr);
    })
  );
  return { columns, values };
}

/**
 * Lower an update's `set` map (field → Expr | { op: Sql }) into assignment
 * fragments. `{ op }` carries an adapter-built arithmetic assignment value
 * (PK increment family); everything else is a plain value assignment.
 */
export function lowerAssignments(
  ctx: QueryContext,
  mode: Mode,
  model: Model<any>,
  set: Readonly<Record<string, Expr | { readonly op: Sql }>>
): Sql[] {
  const assignments: Sql[] = [];
  for (const field of Object.keys(set)) {
    const entry = set[field]!;
    const column = ctx.adapter.identifiers.escape(getColumnName(model, field));
    const value = isOp(entry)
      ? entry.op
      : lowerExpr(ctx, mode, model, field, entry);
    assignments.push(ctx.adapter.set.assign(column, value));
  }
  return assignments;
}

function isOp(
  entry: Expr | { readonly op: Sql }
): entry is { readonly op: Sql } {
  return "op" in entry;
}

/**
 * Lower an update effect's SET clause into a single `Sql` fragment. A scalar
 * update (`rawSet`) lowers through the shared `buildSet` builder — the one
 * source of increment/decrement/push/…/mapped-column assignment semantics. An
 * FK/PK update (`set`, Expr-based) lowers per-column via `lowerAssignments`.
 * The two are mutually exclusive: a scalar update and an FK update are never the
 * same effect.
 */
export function lowerUpdateSet(
  ctx: QueryContext,
  mode: Mode,
  effect: Extract<Effect, { kind: "update" }>
): Sql {
  if (effect.rawSet) {
    const child =
      effect.model === ctx.model
        ? ctx
        : createChildContext(ctx, effect.model, ctx.nextAlias());
    return buildSet(child, effect.rawSet as Record<string, unknown>);
  }
  const assignments = lowerAssignments(ctx, mode, effect.model, effect.set);
  return sql.join(assignments, ", ");
}
