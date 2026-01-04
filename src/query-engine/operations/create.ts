/**
 * Create Operation
 *
 * Builds SQL for create mutations.
 * Returns the created record.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import { buildValues } from "../builders/values-builder";
import { getTableName } from "../context";
import type { QueryContext } from "../types";

interface CreateArgs {
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

/**
 * Build SQL for create operation
 *
 * @param ctx - Query context
 * @param args - Create arguments
 * @returns SQL statement (INSERT with optional RETURNING)
 */
export function buildCreate(ctx: QueryContext, args: CreateArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build VALUES
  const { columns, values } = buildValues(ctx, args.data);

  if (columns.length === 0) {
    throw new Error("No data to insert");
  }

  // Build INSERT
  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Build RETURNING clause if supported (no alias for INSERT RETURNING)
  // Note: MySQL doesn't support RETURNING, so this will be empty
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine INSERT with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL) - just return INSERT
    return insertSql;
  }

  return sql`${insertSql} ${returningSql}`;
}

/**
 * Build SQL for createMany operation
 *
 * @param ctx - Query context
 * @param data - Array of records to create
 * @param skipDuplicates - Whether to skip duplicate key errors
 * @returns SQL statement
 */
export function buildCreateMany(
  ctx: QueryContext,
  data: Record<string, unknown>[],
  skipDuplicates = false
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build VALUES for all records
  const { columns, values } = buildValues(ctx, data);

  if (columns.length === 0 || values.length === 0) {
    throw new Error("No data to insert");
  }

  // Build INSERT
  const table = adapter.identifiers.escape(tableName);
  let insertSql = adapter.mutations.insert(table, columns, values);

  // Add ON CONFLICT DO NOTHING if skipDuplicates
  if (skipDuplicates) {
    const onConflict = adapter.mutations.onConflict(null, sql.raw`NOTHING`);
    insertSql = sql`${insertSql} ${onConflict}`;
  }

  return insertSql;
}
