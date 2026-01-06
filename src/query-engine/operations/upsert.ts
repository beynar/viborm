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
import { getColumnName, getTableName } from "../context";
import type { QueryContext } from "../types";

interface UpsertArgs {
  where: Record<string, unknown>;
  create: Record<string, unknown>;
  update: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

/**
 * Build SQL for upsert operation
 *
 * @param ctx - Query context
 * @param args - Upsert arguments
 * @returns SQL statement (INSERT ... ON CONFLICT ... DO UPDATE)
 */
export function buildUpsert(ctx: QueryContext, args: UpsertArgs): Sql {
  const { adapter, rootAlias } = ctx;
  const tableName = getTableName(ctx.model);

  // Build INSERT from create data
  const { columns, values } = buildValues(ctx, args.create);

  if (columns.length === 0) {
    throw new Error("No data to insert");
  }

  const table = adapter.identifiers.escape(tableName);
  const insertSql = adapter.mutations.insert(table, columns, values);

  // Build conflict target from where (unique fields)
  const conflictTarget = buildConflictTarget(ctx, args.where);

  // Build update action from update data
  const updateAction = buildSet(ctx, args.update);

  // Build ON CONFLICT ... DO UPDATE
  const onConflictSql = adapter.mutations.onConflict(
    conflictTarget,
    sql`UPDATE SET ${updateAction}`
  );

  // Combine INSERT with ON CONFLICT
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
  ctx: QueryContext,
  where: Record<string, unknown>
): Sql {
  const { adapter } = ctx;
  const fields: Sql[] = [];

  for (const [key, value] of Object.entries(where)) {
    if (value === undefined) continue;

    // Check if this is a compound key
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      // Compound key: { userId_orgId: { userId: "1", orgId: "2" } }
      const compound = value as Record<string, unknown>;
      for (const fieldName of Object.keys(compound)) {
        const columnName = getColumnName(ctx.model, fieldName);
        fields.push(adapter.identifiers.escape(columnName));
      }
    } else {
      // Single field
      const columnName = getColumnName(ctx.model, key);
      fields.push(adapter.identifiers.escape(columnName));
    }
  }

  return sql.join(fields, ", ");
}
