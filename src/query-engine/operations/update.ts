/**
 * Update Operation
 *
 * Builds SQL for update mutations.
 * Returns the updated record.
 */

import { type Sql, sql } from "@sql";
import type { PolymorphicStorageValue } from "../builders/polymorphic-mutation";
import { buildSelect } from "../builders/select-builder";
import { buildSet } from "../builders/set-builder";
import { buildWhere } from "../builders/where-builder";
import { buildWhereUnique } from "../builders/where-unique-builder";
import { getTableName } from "../context";
import type { QueryScope } from "../types";
import { buildBulkLimitWhere } from "./bulk-limit";

interface UpdateArgs {
  where: Record<string, unknown>;
  data: Record<string, unknown>;
  polymorphicStorage?: readonly PolymorphicStorageValue<unknown>[];
  select?: Record<string, unknown>;
  include?: Record<string, unknown>;
}

interface UpdateManyArgs {
  where?: Record<string, unknown>;
  data: Record<string, unknown>;
  /** Trusted internal predicate composed after the public filter. */
  predicate?: Sql;
  /** Atomic private polymorphic storage assignments appended after scalars. */
  polymorphicStorage?: readonly PolymorphicStorageValue<unknown>[];
  /**
   * Cap on the number of rows the UPDATE may affect (Prisma 6.x `limit`).
   * WHICH rows are updated is unspecified — there is no `orderBy` on a bulk
   * write. `0` never reaches here; the operation layer short-circuits it.
   */
  limit?: number;
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
  args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
    polymorphicStorage?: readonly PolymorphicStorageValue<unknown>[];
  }
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);

  // `data` is COMPILED input: the record compilers lower every relation
  // mutation into scalar assignments or membership Parts before this leaf, so
  // the SET clause trusts what it is handed. The relation interpreter that once
  // sat here re-derived FK assignments below the canonical program boundary and
  // silently dropped every other relation kind — deleted (distinct-truth
  // Phase 9.4) with all ten callers audited scalar-only.
  const setSql = buildSet(
    ctx,
    args.data,
    undefined,
    args.polymorphicStorage ?? []
  );

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
  const setSql = buildSet(
    ctx,
    args.data,
    undefined,
    args.polymorphicStorage ?? []
  );

  // Build WHERE qualified by table name so relation-filter EXISTS subqueries
  // stay correlated (the unaliased UPDATE target is addressable by its name).
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

  // Build UPDATE
  const table = adapter.identifiers.escape(tableName);
  const updateSql = adapter.mutations.update(table, setSql, limited.where);
  return limited.suffix ? sql`${updateSql} ${limited.suffix}` : updateSql;
}
