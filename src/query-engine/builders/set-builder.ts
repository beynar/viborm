/**
 * Set Builder
 *
 * Builds SET clause for UPDATE operations.
 * Handles simple assignments, increment/decrement, and array operations.
 */

import { isSql, type Sql, sql } from "@sql";
import { getColumnName, getScalarFieldNames, isRelation } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";
import { scalarValueLiteral } from "./values-builder";

/**
 * Build SET clause for UPDATE from update data
 *
 * @param ctx - Query context
 * @param data - Update input data
 * @param alias - Table alias (optional, for qualified columns)
 * @returns SQL for SET clause
 */
export function buildSet(
  ctx: QueryScope,
  data: Record<string, unknown>,
  alias?: string
): Sql {
  const { adapter } = ctx;
  const assignments: Sql[] = [];
  const scalarFields = getScalarFieldNames(ctx.model);

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    if (isRelation(ctx.model, key)) {
      continue; // Skip relations
    }
    if (!scalarFields.includes(key)) {
      continue;
    }

    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, key);
    const column = alias
      ? adapter.identifiers.column(alias, columnName)
      : adapter.identifiers.escape(columnName);

    const assignment = buildAssignment(ctx, key, column, value);
    if (assignment) {
      assignments.push(assignment);
    }
  }

  if (assignments.length === 0) {
    throw new QueryEngineError("No fields to update");
  }

  return sql.join(assignments, ", ");
}

/**
 * Build a single assignment expression
 *
 * Schema validation normalizes all values to operation objects:
 * - Simple values become { set: value }
 * - null becomes { set: null }
 */
function buildAssignment(
  ctx: QueryScope,
  fieldName: string,
  column: Sql,
  value: unknown
): Sql | undefined {
  const { adapter } = ctx;

  // Handle Sql values directly (from connect subqueries)
  if (isSql(value)) {
    return adapter.set.assign(column, value);
  }

  // Handle null values
  if (value === null) {
    return adapter.set.assign(column, adapter.literals.null());
  }

  // Schema validation guarantees value is always an operation object
  if (typeof value !== "object") {
    throw new QueryEngineError(
      "Update value must be an operation object (schema validation should have normalized this)"
    );
  }

  const op = value as Record<string, unknown>;

  // set: assign value directly
  if ("set" in op && op.set !== undefined) {
    const setValue = op.set;
    if (setValue === null) {
      return adapter.set.assign(column, adapter.literals.null());
    }
    return adapter.set.assign(
      column,
      scalarValueLiteral(ctx, fieldName, setValue)
    );
  }

  // Atomic arithmetic stays server-side, so it is exact wherever the dialect's
  // decimal type is. Where there is no exact decimal type it is refused (see
  // assertExactDecimalOperation) rather than computed through a double. The
  // operand binds through scalarValueLiteral so a decimal is cast into the
  // dialect's exact type instead of arriving as a string MySQL would compare
  // and compute with as a float.
  // increment: add to current value
  if ("increment" in op && op.increment !== undefined) {
    assertExactDecimalOperation(ctx, fieldName, "increment");
    return adapter.set.increment(
      column,
      scalarValueLiteral(ctx, fieldName, op.increment)
    );
  }

  // decrement: subtract from current value
  if ("decrement" in op && op.decrement !== undefined) {
    assertExactDecimalOperation(ctx, fieldName, "decrement");
    return adapter.set.decrement(
      column,
      scalarValueLiteral(ctx, fieldName, op.decrement)
    );
  }

  // multiply: multiply current value
  if ("multiply" in op && op.multiply !== undefined) {
    assertExactDecimalOperation(ctx, fieldName, "multiply");
    return adapter.set.multiply(
      column,
      scalarValueLiteral(ctx, fieldName, op.multiply)
    );
  }

  // divide: divide current value. Integer columns must divide as integers
  // (Prisma/Postgres truncate toward zero); the adapter forces this where the
  // dialect would otherwise do real division.
  if ("divide" in op && op.divide !== undefined) {
    const scalarType =
      ctx.model["~"].state.scalars[fieldName]?.["~"].state.type;
    const columnIsInteger = scalarType === "int" || scalarType === "bigint";
    assertExactDecimalOperation(ctx, fieldName, "divide");
    return adapter.set.divide(
      column,
      scalarValueLiteral(ctx, fieldName, op.divide),
      columnIsInteger
    );
  }

  // push/unshift take one value or an array of values; always hand the
  // adapter an element array so array-valued pushes expand element-wise
  // instead of appending one malformed element
  if ("push" in op && op.push !== undefined) {
    return adapter.set.push(
      column,
      Array.isArray(op.push) ? op.push : [op.push]
    );
  }

  if ("unshift" in op && op.unshift !== undefined) {
    return adapter.set.unshift(
      column,
      Array.isArray(op.unshift) ? op.unshift : [op.unshift]
    );
  }

  // Unknown operation - schema validation should prevent this
  throw new QueryEngineError(
    `Unknown update operation: ${Object.keys(op).join(", ")}`
  );
}
