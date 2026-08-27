/**
 * Delete Operation
 *
 * Builds SQL for delete mutations.
 */

import { type Sql, sql } from "@sql";
import { buildSelect } from "../builders/select-builder";
import { buildWhere } from "../builders/where-builder";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { getTableName } from "../context";
import type { QueryScope } from "../types";
import { buildBulkLimitWhere } from "./bulk-limit";

interface DeleteArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface DeleteManyArgs {
  where?: Record<string, unknown>;
  /** Trusted internal predicate composed after the public filter. */
  predicate?: Sql;
  /**
   * Cap on the number of rows the DELETE may affect (Prisma 6.x `limit`).
   * WHICH rows are removed is unspecified — there is no `orderBy` on a bulk
   * write. `0` never reaches here; the operation layer short-circuits it.
   */
  limit?: number;
}

/**
 * Build SQL for delete operation (single record by unique key)
 *
 * @param ctx - Query context
 * @param args - Delete arguments
 * @returns SQL statement (DELETE with optional RETURNING)
 */
export function buildDelete(ctx: QueryScope, args: DeleteArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build WHERE qualified by table name — the same spelling `buildDeleteMany`
  // uses, and for the same two reasons: the unaliased DELETE target is
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

  // Build DELETE
  const table = adapter.identifiers.table(tableName);
  const deleteSql = adapter.mutations.delete(table, whereSql);

  // Build RETURNING clause if supported (no alias for DELETE RETURNING)
  const returningCols = buildSelect(ctx, args.select, args.include, "");
  const returningSql = adapter.mutations.returning(returningCols);

  // Combine DELETE with RETURNING
  if (returningSql.strings.join("").trim() === "") {
    // No RETURNING support (MySQL)
    return deleteSql;
  }

  return sql`${deleteSql} ${returningSql}`;
}

/**
 * Build SQL for deleteMany operation
 *
 * @param ctx - Query context
 * @param args - DeleteMany arguments
 * @returns SQL statement
 */
export function buildDeleteMany(ctx: QueryScope, args: DeleteManyArgs): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // Build WHERE qualified by table name so relation-filter EXISTS subqueries
  // stay correlated (the unaliased DELETE target is addressable by its name).
  // mutationTable lets relation filters wrap subqueries that select from the
  // mutated table on dialects that reject that (MySQL error 1093).
  const publicWhere = buildWhere(
    { ...ctx, mutationTable: tableName },
    args.where,
    tableName
  );
  const whereSql = args.predicate
    ? publicWhere
      ? adapter.operators.and(publicWhere, args.predicate)
      : args.predicate
    : publicWhere;

  // Apply the row cap: a native LIMIT suffix, or a PK-subquery WHERE.
  const limited = buildBulkLimitWhere(
    ctx,
    whereSql,
    args.where,
    args.limit,
    args.predicate
  );

  // Build DELETE
  const table = adapter.identifiers.table(tableName);
  const deleteSql = adapter.mutations.delete(table, limited.where);
  return limited.suffix ? sql`${deleteSql} ${limited.suffix}` : deleteSql;
}

/**
 * Build SQL for the row-returning arm of `deleteMany` — internally named
 * `deleteManyAndReturn`; the client spells it `deleteMany` with a `select`.
 * (Prisma has no equivalent operation at all.)
 *
 * DELETE ... RETURNING on adapters that support it. On adapters without
 * RETURNING this statement is never built: the operation reads the matching rows
 * and deletes them inside one atomic scope instead, because a row cannot be read
 * back after it is gone.
 */
export function buildDeleteManyAndReturn(
  ctx: QueryScope,
  args: DeleteManyArgs & { select?: Record<string, unknown> }
): Sql {
  const deleteSql = buildDeleteMany(ctx, args);

  const returningCols = buildSelect(ctx, args.select, undefined, "");
  const returningSql = ctx.adapter.mutations.returning(returningCols);

  if (returningSql.strings.join("").trim() === "") {
    return deleteSql;
  }

  return sql`${deleteSql} ${returningSql}`;
}
