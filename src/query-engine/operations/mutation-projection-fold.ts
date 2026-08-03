/**
 * Mutation Projection Fold — query-performance-plan Phase 8.1.
 *
 * A mutation that must answer with a RELATION projection used to send its write
 * and then a separate terminal `SELECT` to shape the answer. On a dialect whose
 * `WITH` accepts a data-modifying statement, the two are one statement:
 *
 * ```sql
 * WITH "__viborm_mutation" AS (UPDATE "t" SET … WHERE … RETURNING <every column>)
 * SELECT "t0"."a" AS "a", <correlated relation reads>
 * FROM "__viborm_mutation" AS "t0"
 * ```
 *
 * Why the CTE rather than relation subqueries inside `RETURNING`: an `UPDATE`
 * has no table alias, so an outer column reference emitted inside a `RETURNING`
 * subquery goes out BARE and binds to whatever the subquery's own `FROM` calls
 * that name. That is the `_count` defect `delete-fold.test.ts` documents —
 * `note.id = note.accountId` instead of `account.id = note.accountId`. Here the
 * projection is built over a real aliased `FROM`, so it is the SAME projection
 * the terminal read builds, from the same builder, correlated the same way. The
 * only difference is which relation the rows come from.
 *
 * WHAT THIS BUILDER DOES NOT DECIDE: whether folding is LEGAL. In PostgreSQL
 * every sub-statement of one command sees the same snapshot, so the outer
 * `SELECT` reads the tables as they were BEFORE the mutation. The fold therefore
 * holds only while the projection reads nothing the statement changes. The
 * operation layer answers that — `projectionReadsMutatedModel` and
 * `setCanFireReferentialAction` in `query-engine-v2/shared.ts`, which are the
 * ones that know the projection tree and the `SET`.
 */

import type { QueryParts } from "@adapters";
import { getColumnName } from "@schema/model";
import { type Sql, sql } from "@sql";
import { buildSelectWithAliases } from "../builders/select-builder";
import { getScalarFieldNames } from "../context";
import type { QueryScope } from "../types";

/**
 * The CTE the folded mutation lands in. Reserved-prefixed like every other
 * viborm-owned SQL name (`__viborm_batch_refs`, `__viborm_assert__`) so it can
 * never shadow a user table the projection's own subqueries read.
 */
const MUTATION_CTE = "__viborm_mutation";

/**
 * The mutation's `RETURNING` list for the fold: every scalar column, under its
 * COLUMN name.
 *
 * Not `buildSelect`'s projection, which aliases each column to its FIELD name —
 * a `.map()`ed field would then leave the CTE carrying a name the outer
 * projection (which addresses columns) cannot find. Not the `.omit()`-filtered
 * set either: the CTE is plumbing, and what reaches the caller is decided by the
 * outer `SELECT`, which applies `.omit()` exactly as the terminal read does.
 */
function returningEveryColumn(ctx: QueryScope): Sql {
  return sql.join(
    getScalarFieldNames(ctx.model).map((field) =>
      ctx.adapter.identifiers.escape(getColumnName(ctx.model, field))
    ),
    ", "
  );
}

/**
 * Fold a mutation and the read that shapes its answer into one statement.
 *
 * @param ctx - the mutated model's scope; its `rootAlias` names the CTE in the
 *   outer query, so the projection correlates against the mutated ROW
 *   (post-mutation values, straight out of `RETURNING`).
 * @param args.mutation - the mutating statement WITHOUT a `RETURNING` clause.
 * @param args.select / args.include - the same projection the terminal read
 *   would have carried.
 */
export function buildMutationProjectionFold(
  ctx: QueryScope,
  args: {
    mutation: Sql;
    select?: Record<string, unknown>;
    include?: Record<string, unknown>;
  }
): Sql {
  const { adapter, rootAlias } = ctx;
  const cte = adapter.cte.with([
    {
      name: MUTATION_CTE,
      query: sql`${args.mutation} ${adapter.mutations.returning(
        returningEveryColumn(ctx)
      )}`,
    },
  ]);
  const projection = buildSelectWithAliases(
    ctx,
    args.select,
    args.include,
    rootAlias
  );
  // No WHERE and no LIMIT: the CTE already IS the affected rows, and the callers
  // that fold address a unique row, so there is exactly one. A LIMIT here would
  // be a second spelling of a cardinality the mutation's own `where` fixes.
  const parts: QueryParts = {
    columns: projection.sql,
    from: adapter.identifiers.table(MUTATION_CTE, rootAlias),
  };
  if (projection.lateralJoins.length > 0) {
    parts.joins = projection.lateralJoins;
  }
  return sql`${cte} ${adapter.assemble.select(parts)}`;
}
