/**
 * Set Builder
 *
 * Builds SET clause for UPDATE operations.
 * Handles simple assignments, increment/decrement, and array operations.
 */

import { Sql, sql } from "@sql";
import type { QueryContext } from "../types";
import { getScalarFieldNames, isRelation, getColumnName } from "../context";

/**
 * Build SET clause for UPDATE from update data
 *
 * @param ctx - Query context
 * @param data - Update input data
 * @param alias - Table alias (optional, for qualified columns)
 * @returns SQL for SET clause
 */
export function buildSet(
  ctx: QueryContext,
  data: Record<string, unknown>,
  alias?: string
): Sql {
  const { adapter } = ctx;
  const assignments: Sql[] = [];
  const scalarFields = getScalarFieldNames(ctx.model);

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isRelation(ctx.model, key)) continue; // Skip relations
    if (!scalarFields.includes(key)) continue;

    // Resolve field name to actual column name (handles .map() overrides)
    const columnName = getColumnName(ctx.model, key);
    const column = alias
      ? adapter.identifiers.column(alias, columnName)
      : adapter.identifiers.escape(columnName);

    const assignment = buildAssignment(ctx, column, value);
    if (assignment) {
      assignments.push(assignment);
    }
  }

  if (assignments.length === 0) {
    throw new Error("No fields to update");
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
  ctx: QueryContext,
  column: Sql,
  value: unknown
): Sql | undefined {
  const { adapter } = ctx;

  // Schema validation guarantees value is always an operation object
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "Update value must be an operation object (schema validation should have normalized this)"
    );
  }

  const op = value as Record<string, unknown>;

  // set: assign value directly
  if ("set" in op) {
    const setValue = op.set;
    if (setValue === null) {
      return adapter.set.assign(column, adapter.literals.null());
    }
    return adapter.set.assign(column, adapter.literals.value(setValue));
  }

  // increment: add to current value
  if ("increment" in op && op.increment !== undefined) {
    return adapter.set.increment(column, adapter.literals.value(op.increment));
  }

  // decrement: subtract from current value
  if ("decrement" in op && op.decrement !== undefined) {
    return adapter.set.decrement(column, adapter.literals.value(op.decrement));
  }

  // multiply: multiply current value
  if ("multiply" in op && op.multiply !== undefined) {
    return adapter.set.multiply(column, adapter.literals.value(op.multiply));
  }

  // divide: divide current value
  if ("divide" in op && op.divide !== undefined) {
    return adapter.set.divide(column, adapter.literals.value(op.divide));
  }

  // push: append to array
  if ("push" in op && op.push !== undefined) {
    return adapter.set.push(column, adapter.literals.value(op.push));
  }

  // unshift: prepend to array
  if ("unshift" in op && op.unshift !== undefined) {
    return adapter.set.unshift(column, adapter.literals.value(op.unshift));
  }

  // Unknown operation - schema validation should prevent this
  throw new Error(`Unknown update operation: ${Object.keys(op).join(", ")}`);
}
