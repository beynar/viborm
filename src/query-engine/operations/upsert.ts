/**
 * Upsert Operation
 *
 * Builds SQL for upsert mutations.
 * Inserts a new record or updates existing one on conflict.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import { buildSet } from "../builders/set-builder";
import { buildValues } from "../builders/values-builder";
import { buildWhere } from "../builders/where-builder";
import { getWhereUniqueFieldNames } from "../builders/where-unique-builder";
import { getColumnName, getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";

interface UpsertArgs {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
  /**
   * Adapter-owned conflict-target filter for partial unique index matching.
   */
  targetWhere?: Record<string, unknown>;
  /**
   * Adapter-owned conditional update filter.
   */
  setWhere?: Record<string, unknown>;
}

/**
 * Build SQL for upsert operation
 *
 * @param ctx - Query context
 * @param args - Upsert arguments
 * @returns SQL statement for the adapter-owned upsert form
 */
export function buildUpsert(ctx: QueryScope, args: UpsertArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build INSERT from create data
  const { columns, values } = buildValues(ctx, args.create);

  if (columns.length === 0) {
    throw new QueryEngineError("No data to insert");
  }

  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Build conflict target from where (unique fields)
  const conflictTarget = buildConflictTarget(ctx, args.where);

  // Build targetWhere for partial unique index matching.
  // Use table name as alias since this references the table being inserted into
  const targetWhereSql = args.targetWhere
    ? buildWhere(ctx, args.targetWhere, tableName)
    : undefined;

  // Build update action from update data
  const updateAction = buildSet(ctx, args.update);

  // Build setWhere for conditional updates.
  // Use table name as alias since this references the existing row
  const setWhereSql = args.setWhere
    ? buildWhere(ctx, args.setWhere, tableName)
    : undefined;

  // Build adapter-owned upsert conflict handling with optional filters.
  const onConflictSql = adapter.mutations.onConflict(
    conflictTarget,
    adapter.mutations.onConflictUpdate(updateAction, setWhereSql),
    targetWhereSql
  );

  // Combine INSERT with adapter-owned conflict handling.
  let upsertSql = sql`${insertSql} ${onConflictSql}`;

  // Build RETURNING clause if supported
  // Use empty alias since INSERT doesn't have a FROM clause with table aliases
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  if (returningSql.strings.join("").trim() !== "") {
    upsertSql = sql`${upsertSql} ${returningSql}`;
  }

  return upsertSql;
}

/**
 * Build conflict target from where input
 * Extracts the unique key fields from the where clause
 */
function buildConflictTarget(
  ctx: QueryScope,
  where: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const fields = getWhereUniqueFieldNames(ctx, where).map((fieldName) => {
    const columnName = getColumnName(ctx.model, fieldName);
    return adapter.identifiers.escape(columnName);
  });

  return sql.join(fields, ", ");
}
