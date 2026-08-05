/**
 * Mutation-target subquery hiding (MySQL ERROR 1093).
 *
 * A subquery that reads the table its enclosing statement is MUTATING is legal on
 * PostgreSQL and SQLite and rejected by MySQL. Hiding it behind a derived table
 * sidesteps the restriction — the derived table is materialized before the write
 * — while the correlation to the outer mutation survives as an outer reference
 * (MySQL 8.0.14+).
 *
 * ONE home for the rule, because two builders need it in different enclosing
 * syntax: a relation filter's `EXISTS (…)` supplies its own parentheses, and a
 * to-one `connect` lookup in an UPDATE's `SET` is a scalar subquery that supplies
 * none. {@link hideMutationTarget} therefore returns the bare
 * `SELECT * FROM (…) alias` and each caller parenthesizes for its own position.
 */

import { type Sql, sql } from "@sql";
import type { QueryScope } from "../types";

/**
 * Does this subquery read the table the enclosing statement mutates, on a dialect
 * that refuses it? `mutationTable` is declared by the statement builders that own
 * a mutation target (`buildUpdateStatement`, `buildDelete`, the bulk twins, the
 * junction statements); a scope without it is a plain read and never wraps.
 */
export function readsMutationTarget(
  ctx: QueryScope,
  tables: readonly string[]
): boolean {
  return (
    ctx.mutationTable !== undefined &&
    !ctx.adapter.capabilities.supportsMutationTargetInSubquery &&
    tables.includes(ctx.mutationTable)
  );
}

/** The derived-table wrap itself, without outer parentheses. */
export function hideMutationTarget(ctx: QueryScope, subquery: Sql): Sql {
  return sql`SELECT * FROM ${ctx.adapter.subqueries.correlate(
    subquery,
    ctx.nextAlias()
  )}`;
}
