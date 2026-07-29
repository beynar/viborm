/**
 * Bulk-mutation row cap (`updateMany`/`deleteMany` `limit`, Prisma 6.x).
 *
 * `limit` caps how MANY rows a bulk write may affect. It deliberately does NOT
 * say WHICH rows: there is no `orderBy` on a bulk write, so the affected subset
 * is whatever the database reaches first. That is Prisma's contract too, and it
 * is the reason this module never invents an ordering — a stable-looking
 * `ORDER BY` here would promise a portability that does not exist.
 *
 * Two spellings, chosen by capability, never by dialect name:
 *
 * - `supportsMutationRowLimit` (MySQL): the native `UPDATE|DELETE … LIMIT n`
 *   suffix. The `WHERE` is untouched, so the ERROR 1093 derived-table wrapper
 *   that relation filters already apply keeps working unchanged.
 * - otherwise (PostgreSQL, SQLite): the mutation's whole `WHERE` is replaced by
 *   a primary-key membership test against a capped subquery —
 *   `WHERE (pk…) IN (SELECT pk… FROM t WHERE <filter> LIMIT n)`. The subquery
 *   carries the original filter, so the two forms select from the same set.
 *   Compound primary keys use the row-value form, which PostgreSQL and SQLite
 *   (3.15+, i.e. every build this project runs on) both accept.
 */

import { type Sql, sql } from "@sql";
import { getPrimaryKeyFields } from "../builders/correlation-utils";
import { getColumnName, getTableName } from "../context";
import type { QueryScope } from "../types";
import { buildFind } from "./find-common";

/** What a bulk write must splice in to honor a `limit`. */
export interface BulkLimitParts {
  /** The `WHERE` the mutation should use (rewritten on the subquery dialects). */
  where: Sql | undefined;
  /** A native `LIMIT n` suffix to append to the statement, where supported. */
  suffix: Sql | undefined;
}

/**
 * Realize `limit` for one bulk `UPDATE`/`DELETE`.
 *
 * `limit === undefined` returns `where` unchanged and no suffix, so every
 * uncapped bulk write keeps producing byte-identical SQL.
 *
 * `limit === 0` must never reach here: the operation layer short-circuits it to
 * `{ count: 0 }` without executing any statement (a `LIMIT 0` write would be a
 * pointless round trip, and the PK-subquery form would still take locks).
 */
export function buildBulkLimitWhere(
  ctx: QueryScope,
  where: Sql | undefined,
  filter: Record<string, unknown> | undefined,
  limit: number | undefined
): BulkLimitParts {
  if (limit === undefined) {
    return { where, suffix: undefined };
  }
  if (ctx.adapter.capabilities.supportsMutationRowLimit) {
    return {
      where,
      suffix: ctx.adapter.clauses.limit(ctx.adapter.literals.value(limit)),
    };
  }
  return {
    where: buildPrimaryKeyLimitWhere(ctx, filter, limit),
    suffix: undefined,
  };
}

/**
 * `(pk…) IN (SELECT pk… FROM t WHERE <filter> LIMIT n)`.
 *
 * The subquery is built by `buildFind` on a FRESH scope, so it gets its own
 * alias (`t0`, …) and cannot be confused with the unaliased mutation target it
 * is nested inside. The outer columns stay qualified by table name, which is how
 * the uncapped bulk writes already address the mutation target.
 */
function buildPrimaryKeyLimitWhere(
  ctx: QueryScope,
  filter: Record<string, unknown> | undefined,
  limit: number
): Sql {
  const { adapter } = ctx;
  const tableName = getTableName(ctx.model);
  const primaryKeyFields = getPrimaryKeyFields(ctx.model);

  const columns = primaryKeyFields.map((field) =>
    adapter.identifiers.column(tableName, getColumnName(ctx.model, field))
  );
  // A single-column PK stays a plain `col IN (…)`; only a compound PK needs the
  // row-value constructor, which is the narrower grammar of the two.
  const target =
    columns.length === 1 ? columns[0]! : sql`(${sql.join(columns, ", ")})`;

  const capped = buildFind(
    {
      adapter,
      model: ctx.model,
      nextAlias: ctx.nextAlias,
      rootAlias: ctx.nextAlias(),
    },
    {
      ...(filter ? { where: filter } : {}),
      select: Object.fromEntries(
        primaryKeyFields.map((field) => [field, true])
      ),
    },
    { limit }
  );

  return adapter.operators.in(target, adapter.subqueries.scalar(capped));
}
