/**
 * Set Builder
 *
 * Builds SET clause for UPDATE operations.
 * Handles simple assignments, increment/decrement, and array operations.
 */

import type { ArithmeticTarget } from "@adapters/database-adapter";
import { isSql, type Sql, sql } from "@sql";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { getColumnName, getScalarFieldNames, isRelation } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import {
  decimalDescriptorOf,
  decimalListDescriptorOfState,
} from "./decimal-field";
import {
  type PolymorphicStorageValue,
  polymorphicStorageMembers,
} from "./polymorphic-mutation";
import {
  buildScalarSqlValueForScalar,
  decimalListMembers,
  scalarValueLiteral,
} from "./values-builder";

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
  alias?: string,
  polymorphicStorage: readonly PolymorphicStorageValue<unknown>[] = []
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

  appendPolymorphicAssignments(ctx, assignments, alias, polymorphicStorage);

  if (assignments.length === 0) {
    throw new QueryEngineError("No fields to update");
  }

  return sql.join(assignments, ", ");
}

function appendPolymorphicAssignments(
  ctx: QueryScope,
  assignments: Sql[],
  alias: string | undefined,
  values: readonly PolymorphicStorageValue<unknown>[]
): void {
  for (const { column, value } of polymorphicStorageMembers(ctx, values)) {
    const target = alias
      ? ctx.adapter.identifiers.column(alias, column.name)
      : ctx.adapter.identifiers.escape(column.name);
    assignments.push(
      ctx.adapter.set.assign(
        target,
        buildScalarSqlValueForScalar(ctx, column.scalar, column.name, value)
      )
    );
  }
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

  // Atomic arithmetic stays server-side, so it is exact everywhere: the operand
  // binds through scalarValueLiteral, which puts a decimal into the SAME
  // physical domain as its column (an unscaled coefficient on SQLite, an exact
  // `NUMERIC(p,s)`/`DECIMAL(p,s)` operand elsewhere), instead of arriving as a
  // string MySQL would compare and compute with as a float.
  //
  // There is no decimal precedence to arbitrate below. The decimal update
  // schema is an exact-one union, so a decimal payload carries exactly one
  // operation; the ladder that follows is the owner for int, number and bigint,
  // whose partial bags this deliberately does not change.
  // increment: add to current value
  if ("increment" in op && op.increment !== undefined) {
    return adapter.set.increment(
      column,
      scalarValueLiteral(ctx, fieldName, op.increment),
      arithmeticTarget(ctx, fieldName)
    );
  }

  // decrement: subtract from current value
  if ("decrement" in op && op.decrement !== undefined) {
    return adapter.set.decrement(
      column,
      scalarValueLiteral(ctx, fieldName, op.decrement),
      arithmeticTarget(ctx, fieldName)
    );
  }

  // multiply: multiply current value. A decimal target carries its domain, so
  // the adapter quantizes the product back to the field's scale.
  if ("multiply" in op && op.multiply !== undefined) {
    return adapter.set.multiply(
      column,
      scalarValueLiteral(ctx, fieldName, op.multiply),
      arithmeticTarget(ctx, fieldName)
    );
  }

  // divide: divide current value. Integer columns must divide as integers
  // (Prisma/Postgres truncate toward zero); the adapter forces this where the
  // dialect would otherwise do real division. A decimal target quantizes the
  // quotient to the field's scale instead.
  if ("divide" in op && op.divide !== undefined) {
    const target = arithmeticTarget(ctx, fieldName);
    if (target.decimal) {
      assertDivisorIsNotZero(fieldName, op.divide);
    }
    return adapter.set.divide(
      column,
      scalarValueLiteral(ctx, fieldName, op.divide),
      target
    );
  }

  // push/unshift take one value or an array of values; always hand the
  // adapter an element array so array-valued pushes expand element-wise
  // instead of appending one malformed element
  if ("push" in op && op.push !== undefined) {
    return adapter.set.push(column, listElements(ctx, fieldName, op.push));
  }

  if ("unshift" in op && op.unshift !== undefined) {
    return adapter.set.unshift(
      column,
      listElements(ctx, fieldName, op.unshift)
    );
  }

  // Unknown operation - schema validation should prevent this
  throw new QueryEngineError(
    `Unknown update operation: ${Object.keys(op).join(", ")}`
  );
}

/**
 * The elements a push/unshift appends, in the destination container's own
 * vocabulary.
 *
 * `set.push`/`set.unshift` take JavaScript VALUES and let the adapter serialize
 * the whole batch into its container format, which is right for every list
 * whose members mean the same thing in JSON as in the column. A decimal list is
 * the exception plan 6.3 names: its JSON container holds unscaled coefficient
 * strings, so an appended `1.2` would be written beside members spelled `"120"`
 * and read back as 0.012. Converting HERE keeps the adapter's one serialization
 * and changes only what it is given.
 */
function listElements(
  ctx: QueryScope,
  fieldName: string,
  value: unknown
): unknown[] {
  const elements = Array.isArray(value) ? value : [value];
  const listDomain = decimalListDescriptorOfState(
    ctx.model["~"].state.scalars[fieldName]?.["~"].state
  );
  return listDomain
    ? decimalListMembers(ctx.adapter, fieldName, elements, listDomain)
    : elements;
}

/**
 * What the assignment's target column IS, in the vocabulary the adapter needs
 * to choose an arithmetic spelling. The engine reads the declared scalar; the
 * adapter decides what SQL that implies.
 */
function arithmeticTarget(
  ctx: QueryScope,
  fieldName: string
): ArithmeticTarget {
  const scalarType = ctx.model["~"].state.scalars[fieldName]?.["~"].state.type;
  return {
    integer: scalarType === "int" || scalarType === "bigint",
    decimal: decimalDescriptorOf(ctx.model, fieldName),
  };
}

/**
 * Division of an exact decimal by zero fails HERE, before any statement is
 * issued, because the operand's exact value is knowable at build time and every
 * dialect answers it differently otherwise — SQLite yields NULL (silently
 * erasing the column), MySQL yields NULL or an error depending on the session's
 * SQL mode, and PostgreSQL raises. One refusal, one message, no I/O.
 *
 * Only decimals: an int or float divisor keeps the database's own answer, which
 * this program does not change.
 */
function assertDivisorIsNotZero(fieldName: string, divisor: unknown): void {
  if (canonicalizeDecimal(divisor) !== "0") return;
  throw new QueryEngineError(
    `Cannot divide decimal field '${fieldName}' by zero.`
  );
}
