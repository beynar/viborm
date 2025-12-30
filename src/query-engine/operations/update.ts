/**
 * Update Operation
 *
 * Builds SQL for update mutations.
 * Returns the updated record.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { getTableName, isRelation, getRelationInfo } from "../context";
import { buildSet } from "../builders/set-builder";
import { buildWhereUnique, buildWhere } from "../builders/where-builder";
import { buildSelect } from "../builders/select-builder";

interface UpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface UpdateManyArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
}

/**
 * Process relation operations (connect/disconnect) and convert to FK assignments.
 * For to-one relations where the current model holds the FK, we can translate
 * connect/disconnect to direct FK field updates.
 *
 * @param ctx - Query context
 * @param data - Update data containing scalar and relation fields
 * @returns Processed data with FK assignments from relation operations
 */
function processRelationOperations(
  ctx: QueryContext,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;

    // Check if this is a relation field
    if (isRelation(ctx.model, key)) {
      const relationInfo = getRelationInfo(ctx, key);
      if (!relationInfo) continue;

      // Only handle to-one relations where current model holds FK
      const relState = relationInfo.relation["~"].state;
      if (
        (relState.type === "manyToOne" || relState.type === "oneToOne") &&
        relState.fields &&
        relState.references
      ) {
        const mutation = value as Record<string, unknown>;
        const fields = Array.isArray(relState.fields)
          ? relState.fields
          : [relState.fields];
        const references = Array.isArray(relState.references)
          ? relState.references
          : [relState.references];

        // Handle connect: set FK to target's PK value
        if (mutation.connect !== undefined) {
          const connectInput = mutation.connect as Record<string, unknown>;
          for (let i = 0; i < fields.length; i++) {
            const fkField = fields[i] as string;
            const refField = references[i] as string;
            // Wrap in { set: value } for the set-builder
            result[fkField] = { set: connectInput[refField] };
          }
        }

        // Handle disconnect: set FK to NULL
        if (mutation.disconnect !== undefined) {
          for (const fkField of fields) {
            result[fkField as string] = { set: null };
          }
        }
      }
      // Skip other relation operations (they need transaction handling)
    } else {
      // Pass through scalar fields
      result[key] = value;
    }
  }

  return result;
}

/**
 * Build SQL for update operation (single record by unique key)
 *
 * @param ctx - Query context
 * @param args - Update arguments
 * @returns SQL statement (UPDATE with optional RETURNING)
 */
export function buildUpdate(ctx: QueryContext, args: UpdateArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Process relation operations (connect/disconnect) to FK assignments
  const processedData = processRelationOperations(ctx, args.data);

  // Build SET clause with processed data
  const setSql = buildSet(ctx, processedData);

  // Build WHERE from unique input (no alias for UPDATE statements)
  const whereSql = buildWhereUnique(ctx, args.where, "");

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  const updateSql = adapter.mutations.update(table, setSql, whereSql);

  // Build RETURNING clause if supported (no alias for UPDATE RETURNING)
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine UPDATE with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL)
    return updateSql;
  }

  return sql`${updateSql} ${returningSql}`;
}

/**
 * Build SQL for updateMany operation
 *
 * @param ctx - Query context
 * @param args - UpdateMany arguments
 * @returns SQL statement
 */
export function buildUpdateMany(ctx: QueryContext, args: UpdateManyArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SET clause
  const setSql = buildSet(ctx, args.data);

  // Build WHERE (optional for updateMany, no alias for UPDATE statements)
  const whereSql = buildWhere(ctx, args.where, "");

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  return adapter.mutations.update(table, setSql, whereSql);
}
