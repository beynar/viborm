/**
 * Update Operation
 *
 * Builds SQL for update mutations.
 * Returns the updated record.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import { buildSet } from "../builders/set-builder";
import { buildWhere } from "../builders/where-builder";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { getRelationInfo, getTableName, isRelation } from "../context";
import type { QueryScope } from "../types";
import { buildBulkLimitWhere } from "./bulk-limit";

interface UpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface UpdateManyArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
  /**
   * Cap on the number of rows the UPDATE may affect (Prisma 6.x `limit`).
   * WHICH rows are updated is unspecified — there is no `orderBy` on a bulk
   * write. `0` never reaches here; the operation layer short-circuits it.
   */
  limit?: number;
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
  ctx: QueryScope,
  data: Record<string, unknown>
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
/**
 * The bare `UPDATE … SET … WHERE …` for a unique target, with no `RETURNING`.
 *
 * Split out of {@link buildUpdate} so Phase 8.1's CTE fold can supply its own
 * all-columns `RETURNING` (`mutation-projection-fold.ts`) — the two callers must
 * write the same rows the same way, so the statement has one home.
 */
export function buildUpdateStatement(
  ctx: QueryScope,
  args: { where: Record<string, unknown>; data: Record<string, unknown> }
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Process relation operations (connect/disconnect) to FK assignments
  const processedData = processRelationOperations(ctx, args.data);

  // Build SET clause with processed data
  const setSql = buildSet(ctx, processedData);

  // Build WHERE qualified by table name — the same spelling `buildUpdateMany`
  // uses, and for the same two reasons: the unaliased UPDATE target is
  // addressable only by its name, so a relation filter's EXISTS subquery
  // correlates against `tbl`.`col` instead of a bare `col` that would bind to
  // the RELATED table whenever both carry that column; and `mutationTable` lets
  // that subquery be wrapped in a derived table on dialects that reject reading
  // the mutated table (MySQL error 1093).
  const whereSql = buildWhereUnique(
    { ...ctx, mutationTable: tableName },
    args.where,
    tableName
  );

  const table = adapter.identifiers.escape(tableName);
  return adapter.mutations.update(table, setSql, whereSql);
}

export function buildUpdate(ctx: QueryScope, args: UpdateArgs): Sql {
  const { adapter } = ctx;
  const updateSql = buildUpdateStatement(ctx, args);

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
/**
 * Build SQL for the row-returning arm of `updateMany` — internally named
 * `updateManyAndReturn`; the client spells it `updateMany` with a `select`.
 *
 * UPDATE ... RETURNING on adapters that support it. On adapters without
 * RETURNING the operation program uses an atomic select/update/re-select
 * sequence instead of this statement.
 */
export function buildUpdateManyAndReturn(
  ctx: QueryScope,
  args: UpdateManyArgs & { select?: Record<string, unknown> }
): Sql {
  const updateSql = buildUpdateMany(ctx, args);

  const returningCols = buildSelect(ctx, args.select, undefined, "");
  const returningSql = ctx.adapter.mutations.returning(returningCols);

  if (returningSql.strings.join("").trim() === "") {
    return updateSql;
  }

  return sql`${updateSql} ${returningSql}`;
}

export function buildUpdateMany(ctx: QueryScope, args: UpdateManyArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build SET clause
  const setSql = buildSet(ctx, args.data);

  // Build WHERE qualified by table name so relation-filter EXISTS subqueries
  // stay correlated (the unaliased UPDATE target is addressable by its name).
  // mutationTable lets relation filters wrap subqueries that select from the
  // mutated table on dialects that reject that (MySQL error 1093).
  const whereSql = buildWhere(
    { ...ctx, mutationTable: tableName },
    args.where,
    tableName
  );

  // Apply the row cap: a native LIMIT suffix, or a PK-subquery WHERE.
  const limited = buildBulkLimitWhere(ctx, whereSql, args.where, args.limit);

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  const updateSql = adapter.mutations.update(table, setSql, limited.where);
  return limited.suffix ? sql`${updateSql} ${limited.suffix}` : updateSql;
}
