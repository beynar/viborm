/**
 * Find Common
 *
 * Shared logic for findFirst/findMany operations.
 * Handles cursor-based pagination and distinct.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { QueryEngineError } from "../types";
import { getTableName, getScalarFieldNames, getColumnName } from "../context";
import { buildSelect, buildSelectWithAliases } from "../builders/select-builder";
import { buildWhere } from "../builders/where-builder";
import { buildOrderBy } from "../builders/orderby-builder";

/**
 * Common find arguments
 */
export interface FindArgs {
  where?: Record<string, unknown>;
  orderBy?: Record<string, unknown> | Record<string, unknown>[];
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  cursor?: Record<string, unknown>;
  skip?: number;
  distinct?: string[];
}

/**
 * Options for buildFind
 */
export interface FindOptions {
  /** Limit number of results (1 for findFirst, take value for findMany, undefined for no limit) */
  limit?: number | undefined;
}

/**
 * Build SQL for find operations (shared between findFirst and findMany)
 *
 * @param ctx - Query context
 * @param args - Find arguments
 * @param options - Find options
 * @returns SQL statement
 */
export function buildFind(ctx: QueryContext, args: FindArgs, options: FindOptions = {}): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SELECT columns - use buildSelectWithAliases if distinct is needed
  // so the adapter can reference columns by alias in outer SELECT
  let columns: Sql;
  let columnAliases: string[] | undefined;

  if (args.distinct && args.distinct.length > 0) {
    const selectResult = buildSelectWithAliases(ctx, args.select, args.include, rootAlias);
    columns = selectResult.sql;
    columnAliases = selectResult.aliases;
  } else {
    columns = buildSelect(ctx, args.select, args.include, rootAlias);
  }

  // Build FROM
  const from = adapter.identifiers.table(tableName, rootAlias);

  // Build WHERE with cursor conditions
  let where = buildWhere(ctx, args.where, rootAlias);

  // Add cursor condition if specified
  if (args.cursor) {
    const cursorCondition = buildCursorCondition(ctx, args.cursor, args.orderBy, rootAlias);
    if (cursorCondition) {
      where = where
        ? adapter.operators.and(where, cursorCondition)
        : cursorCondition;
    }
  }

  // Build ORDER BY
  const orderBy = buildOrderBy(ctx, args.orderBy, rootAlias);

  // Build LIMIT
  const limit = options.limit !== undefined ? adapter.literals.value(options.limit) : undefined;

  // Build OFFSET (skip)
  const offset = args.skip !== undefined ? adapter.literals.value(args.skip) : undefined;

  // Handle DISTINCT
  const distinct = args.distinct ? buildDistinct(ctx, args.distinct, rootAlias) : undefined;

  // Assemble query parts
  const parts: Parameters<typeof adapter.assemble.select>[0] = {
    columns,
    from,
  };

  if (distinct && columnAliases) {
    parts.distinct = distinct;
    parts.distinctColumnAliases = columnAliases;
  } else if (distinct) {
    parts.distinct = distinct;
  }
  if (where) parts.where = where;
  if (orderBy) parts.orderBy = orderBy;
  if (limit) parts.limit = limit;
  if (offset) parts.offset = offset;

  return adapter.assemble.select(parts);
}

/**
 * Build cursor condition for Prisma-style cursor pagination.
 *
 * The cursor is a unique identifier (usually the ID field).
 * Prisma includes the cursor record by default (use skip: 1 to exclude).
 * We use >= / <= to include the cursor record.
 *
 * @param ctx - Query context
 * @param cursor - Cursor object (e.g., { id: "abc" })
 * @param orderBy - Order by specification
 * @param alias - Table alias
 * @returns SQL condition for cursor
 * @throws QueryEngineError if cursor contains null values
 */
function buildCursorCondition(
  ctx: QueryContext,
  cursor: Record<string, unknown>,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): Sql | undefined {
  // Get cursor field and value
  const cursorEntries = Object.entries(cursor);
  if (cursorEntries.length === 0) return undefined;

  // Validate no null values in cursor
  for (const [field, value] of cursorEntries) {
    if (value === null || value === undefined) {
      throw new QueryEngineError(
        `Cursor field '${field}' cannot be null or undefined. ` +
        `Cursor must point to a specific record.`
      );
    }
  }

  // Single field cursor (most common case)
  if (cursorEntries.length === 1) {
    const [cursorField, cursorValue] = cursorEntries[0]!;
    return buildSingleFieldCursor(ctx, cursorField, cursorValue, orderBy, alias);
  }

  // Compound cursor - validate and build
  return buildCompoundCursor(ctx, cursor, orderBy, alias);
}

/**
 * Build cursor condition for a single field cursor.
 * Uses >= / <= to include the cursor record (Prisma behavior).
 */
function buildSingleFieldCursor(
  ctx: QueryContext,
  cursorField: string,
  cursorValue: unknown,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): Sql {
  const { adapter } = ctx;
  // Resolve field name to actual column name (handles .map() overrides)
  const columnName = getColumnName(ctx.model, cursorField);
  const column = adapter.identifiers.column(alias, columnName);
  const value = adapter.literals.value(cursorValue);

  // Determine direction from orderBy
  const direction = getFieldDirection(cursorField, orderBy);

  // Prisma includes cursor record by default:
  // - For ascending order, we want records >= cursor
  // - For descending order, we want records <= cursor
  if (direction === "desc") {
    return adapter.operators.lte(column, value);
  } else {
    return adapter.operators.gte(column, value);
  }
}

/**
 * Build cursor condition for compound cursor (multiple fields).
 *
 * Validates that all fields have the same sort direction.
 * Throws error for mixed directions as they require complex tuple logic.
 *
 * Uses row value comparison: (a, b) >= (cursor_a, cursor_b)
 */
function buildCompoundCursor(
  ctx: QueryContext,
  cursor: Record<string, unknown>,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined,
  alias: string
): Sql {
  const { adapter } = ctx;
  const entries = Object.entries(cursor);

  // Validate all fields have same direction
  const directions = entries.map(([field]) => getFieldDirection(field, orderBy));
  const firstDirection = directions[0];
  const hasMixedDirections = directions.some(d => d !== firstDirection);

  if (hasMixedDirections) {
    throw new QueryEngineError(
      "Compound cursor with mixed sort directions (asc/desc) is not supported. " +
      "Either use a single-field cursor or ensure all orderBy fields use the same direction."
    );
  }

  // Build column tuple (resolve field names to column names)
  const columns = entries.map(([field]) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.column(alias, columnName);
  });

  // Build value tuple
  const values = entries.map(([, value]) =>
    adapter.literals.value(value)
  );

  // Build: (col1, col2, ...) >= (val1, val2, ...) or <= for desc
  // Prisma includes cursor record by default
  const columnTuple = sql`(${sql.join(columns, ", ")})`;
  const valueTuple = sql`(${sql.join(values, ", ")})`;

  if (firstDirection === "desc") {
    return sql`${columnTuple} <= ${valueTuple}`;
  } else {
    return sql`${columnTuple} >= ${valueTuple}`;
  }
}

/**
 * Get sort direction for a field from orderBy specification
 *
 * Handles both formats:
 * - String: { field: "desc" }
 * - Object: { field: { sort: "desc", nulls: "last" } }
 */
function getFieldDirection(
  field: string,
  orderBy: Record<string, unknown> | Record<string, unknown>[] | undefined
): "asc" | "desc" {
  if (!orderBy) return "asc";

  // Normalize to array
  const orderByArray = Array.isArray(orderBy) ? orderBy : [orderBy];

  // Find the field in orderBy
  for (const order of orderByArray) {
    if (field in order) {
      const direction = order[field];

      // String format: { field: "desc" }
      if (typeof direction === "string") {
        if (direction === "desc" || direction === "Desc") {
          return "desc";
        }
        return "asc";
      }

      // Object format: { field: { sort: "desc", nulls: "last" } }
      if (typeof direction === "object" && direction !== null) {
        const sortValue = (direction as Record<string, unknown>).sort;
        if (sortValue === "desc" || sortValue === "Desc") {
          return "desc";
        }
        return "asc";
      }

      return "asc";
    }
  }

  // Default to ascending
  return "asc";
}

/**
 * Build DISTINCT clause for find operations.
 *
 * PostgreSQL: DISTINCT ON (field1, field2, ...)
 * MySQL/SQLite: Simulated via ROW_NUMBER() in the adapter
 *
 * @param ctx - Query context
 * @param distinct - Array of field names for distinct
 * @param alias - Table alias
 * @returns SQL for DISTINCT clause
 */
function buildDistinct(
  ctx: QueryContext,
  distinct: string[],
  alias: string
): Sql | undefined {
  if (distinct.length === 0) return undefined;

  const { adapter } = ctx;

  // Validate distinct fields exist
  const scalarFields = getScalarFieldNames(ctx.model);
  for (const field of distinct) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `Distinct field '${field}' not found on model '${ctx.model.name}'`
      );
    }
  }

  // Build column list for distinct (resolve field names to column names)
  // The adapter will handle database-specific implementation
  const columns = distinct.map((field) => {
    const columnName = getColumnName(ctx.model, field);
    return adapter.identifiers.column(alias, columnName);
  });

  return sql.join(columns, ", ");
}
