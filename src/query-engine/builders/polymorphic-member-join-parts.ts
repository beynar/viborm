/**
 * Membership-FIRST join parts for one polymorphic collection member.
 *
 * WHY THIS EXISTS AND WHY THE INNER TRAVERSAL CANNOT SERVE
 *
 * `JunctionRelationTraversal.from()` is the comma pair `member AS jt, target AS t`
 * and its `conditions()` are the correlation and the junction join — BOTH of which
 * land in the WHERE. That is an INNER JOIN by construction: a membership row whose
 * target row is missing produces no row at all, so the orphan silently disappears.
 * Plan §8.2 refuses that reading outright: "An inner join that silently drops the
 * membership is not an acceptable strict carrier… Reusing today's inner traversal
 * unchanged cannot satisfy this contract."
 *
 * Compounding it, `buildNestedReadWindow` folds the user's `where`, the cursor
 * condition and the correlation into ONE `where`, so a filtered-out target and an
 * orphan become indistinguishable — and "a type allow-list, filter, cursor, `take`,
 * or `LIMIT` cannot hide malformed stored membership" fails.
 *
 * So the integrity facts are computed by TWO correlated scalar subqueries per arm,
 * neither of which carries any user filter, window, cursor or allow-list. The comma
 * `fromClause` cannot express a LEFT JOIN, which is why this composer is here and
 * not in `many-to-many-utils.ts`. The `every` quantifier reads the same outer FROM
 * for the same reason: an orphan cannot satisfy a target predicate, so it is a
 * violation, and an inner join would drop it.
 */

import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { type Sql, sql } from "@sql";
import { getColumnName, getTableName } from "../context";
import { QueryEngineError, type QueryScope } from "../types";
import type { BoundJunctionMembership } from "./relation-data-builder";

export interface PolymorphicMemberIntegrityParts {
  /**
   * `(SELECT COUNT(*) FROM <member> jt WHERE <correlation>)` — every membership
   * row this owner row holds in this member table, before anything else.
   */
  readonly membership: Sql;
  /**
   * `(SELECT COUNT(*) FROM <member> jt LEFT JOIN <target> t ON <join>
   *   WHERE <correlation> AND t.<firstReferencedField> IS NULL)`
   *
   * COUNT(*) is never NULL, so no COALESCE portability question arises — a single
   * `SUM(CASE …)` would be NULL over zero rows, which is why it is not used.
   */
  readonly orphans: Sql;
}

/**
 * `<member> AS jt LEFT JOIN <target> AS t ON <join>` — the membership-first FROM.
 *
 * The outer join is the whole point: it keeps the membership row when its target
 * is gone, which is the only way an orphan can be observed at all.
 */
export function buildPolymorphicMemberOuterFrom(
  ctx: QueryScope,
  membership: BoundJunctionMembership,
  joinCondition: Sql,
  junctionAlias: string,
  targetAlias: string
): Sql {
  const { adapter } = ctx;
  return sql`${adapter.identifiers.table(membership.table, junctionAlias)} ${adapter.joins.left(
    adapter.identifiers.table(
      getTableName(membership.target.model),
      targetAlias
    ),
    joinCondition
  )}`;
}

/**
 * `t.<firstReferencedField> IS NULL` — "this membership row has no target row".
 *
 * The FIRST referenced member is sufficient for a compound target key: a LEFT
 * JOIN miss nulls EVERY target column, and the target side is a PK or a unique
 * and therefore non-nullable, so the other members are null exactly when this
 * one is.
 */
export function buildPolymorphicMemberOrphanProbe(
  ctx: QueryScope,
  membership: BoundJunctionMembership,
  targetAlias: string
): Sql {
  const firstTargetMember = membership.target.members[0];
  if (!firstTargetMember) {
    throw new QueryEngineError(
      `Polymorphic member junction '${membership.table}' has no stored target reference.`
    );
  }
  return ctx.adapter.operators.isNull(
    ctx.adapter.identifiers.column(
      targetAlias,
      getColumnName(membership.target.model, firstTargetMember.referencedField)
    )
  );
}

/**
 * Build one member's owner-scoped integrity facts.
 *
 * Spends NO alias of its own and resolves NO junction algebra: the caller hands
 * over the traversal's own two conditions (correlation, then junction join) and
 * its two aliases, so the arm has exactly one resolution and the alias numbers —
 * which are SQL bytes — stay in the same order as every other junction read.
 */
export function buildPolymorphicMemberIntegrityParts(
  ctx: QueryScope,
  membership: BoundJunctionMembership,
  correlationCondition: Sql,
  joinCondition: Sql,
  junctionAlias: string,
  targetAlias: string
): PolymorphicMemberIntegrityParts {
  const { adapter } = ctx;
  const membershipCount = adapter.subqueries.scalar(
    assembleAdapterSelect(adapter, {
      columns: adapter.aggregates.count(),
      from: adapter.identifiers.table(membership.table, junctionAlias),
      where: correlationCondition,
    })
  );

  const orphanCount = adapter.subqueries.scalar(
    assembleAdapterSelect(adapter, {
      columns: adapter.aggregates.count(),
      from: buildPolymorphicMemberOuterFrom(
        ctx,
        membership,
        joinCondition,
        junctionAlias,
        targetAlias
      ),
      where: adapter.operators.and(
        correlationCondition,
        buildPolymorphicMemberOrphanProbe(ctx, membership, targetAlias)
      ),
    })
  );

  return { membership: membershipCount, orphans: orphanCount };
}
