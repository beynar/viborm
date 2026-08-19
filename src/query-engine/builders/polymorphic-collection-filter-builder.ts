/**
 * Direct polymorphic COLLECTION filters and counts.
 *
 * Both surfaces walk the same per-member junction traversal the collection read
 * walks, so a filter, a count and a projection cannot disagree about which rows
 * a variant holds.
 */

import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { createChildScope } from "../context";
import {
  type PolymorphicToManyRelationInfo,
  QueryEngineError,
  type QueryScope,
} from "../types";
import {
  hideMutationTarget,
  readsMutationTarget,
} from "./mutation-target-subquery";
import {
  buildPolymorphicMemberOrphanProbe,
  buildPolymorphicMemberOuterFrom,
} from "./polymorphic-member-join-parts";
import { polymorphicMemberMembership } from "./relation-data-builder";
import type { BuildNestedWhere } from "./relation-filter-builder";
import {
  buildMembershipJunctionTraversal,
  type JunctionRelationTraversal,
} from "./relation-traversal";

const QUANTIFIERS = ["some", "every", "none"] as const;

/** One arm's traversal plus the member facts the quantifier lowering needs. */
interface MemberArm {
  readonly publicType: string;
  readonly traversal: JunctionRelationTraversal;
  readonly membership: ReturnType<typeof polymorphicMemberMembership>;
  readonly targetModel: Model<any>;
}

function buildMemberArms(
  ctx: QueryScope,
  relation: PolymorphicToManyRelationInfo,
  parentAlias: string
): MemberArm[] {
  const arms: MemberArm[] = [];
  for (const [publicType, member] of relation.storage.members) {
    const membership = polymorphicMemberMembership(member, "owner");
    arms.push({
      publicType,
      membership,
      targetModel: member.targetModel,
      traversal: buildMembershipJunctionTraversal(
        ctx,
        () => membership,
        "many",
        parentAlias
      ),
    });
  }
  return arms;
}

/**
 * Build a direct polymorphic collection filter: `{ some?, every?, none? }`, each
 * carrying one TAGGED member predicate `{ type }` | `{ type, is }` |
 * `{ type, isNot }`.
 *
 * There is no null-presence arm: a collection has no null state (plan §7.3).
 */
export function buildPolymorphicCollectionFilterSql(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  relation: PolymorphicToManyRelationInfo,
  filter: unknown,
  parentAlias: string
): Sql {
  if (!isRecord(filter)) {
    throw new QueryEngineError(
      `Polymorphic collection filter '${relation.name}' must be an object.`
    );
  }
  const conditions: Sql[] = [];
  for (const quantifier of QUANTIFIERS) {
    const tagged = filter[quantifier];
    if (tagged === undefined) continue;
    if (!isRecord(tagged)) {
      throw new QueryEngineError(
        `Polymorphic collection filter '${relation.name}.${quantifier}' requires an object.`
      );
    }
    const arms = buildMemberArms(ctx, relation, parentAlias);
    const publicType = String(tagged.type);
    const selected = arms.find((arm) => arm.publicType === publicType);
    if (!selected) {
      throw new QueryEngineError(
        `Unknown polymorphic target '${publicType}' for relation '${relation.name}'.`
      );
    }
    conditions.push(
      quantifier === "every"
        ? buildEveryCondition(buildNestedWhere, ctx, arms, selected, tagged)
        : buildExistenceCondition(
            buildNestedWhere,
            ctx,
            selected,
            tagged,
            quantifier
          )
    );
  }

  if (conditions.length === 0) {
    throw new QueryEngineError(
      `Polymorphic collection filter '${relation.name}' requires one of: some, every, none.`
    );
  }
  return ctx.adapter.operators.and(...conditions);
}

/** The target predicate of one tagged member predicate, already negated for `isNot`. */
function buildTargetPredicate(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  arm: MemberArm,
  tagged: Readonly<Record<string, unknown>>
): Sql | undefined {
  const nested = isRecord(tagged.is)
    ? tagged.is
    : isRecord(tagged.isNot)
      ? tagged.isNot
      : undefined;
  if (!nested) return undefined;
  const childCtx = createChildScope(
    ctx,
    arm.targetModel,
    arm.traversal.targetAlias
  );
  const predicate = buildNestedWhere(childCtx, nested);
  if (!predicate) return undefined;
  return Object.hasOwn(tagged, "is")
    ? predicate
    : ctx.adapter.operators.not(predicate);
}

/**
 * `some` and `none`: correlated existence, or its absence, of a matching member
 * of the SELECTED arm. `some` is false when that arm is empty; `none` is
 * vacuously true then.
 */
function buildExistenceCondition(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  arm: MemberArm,
  tagged: Readonly<Record<string, unknown>>,
  quantifier: "some" | "none"
): Sql {
  const { adapter } = ctx;
  const conditions: Sql[] = [...arm.traversal.conditions()];
  const predicate = buildTargetPredicate(buildNestedWhere, ctx, arm, tagged);
  if (predicate) conditions.push(predicate);
  const subquery = wrapMutationTarget(
    ctx,
    adapter.subqueries.existsCheck(
      arm.traversal.from(),
      adapter.operators.and(...conditions)
    ),
    arm.traversal.tables()
  );
  return quantifier === "some"
    ? adapter.filters.some(subquery)
    : adapter.filters.none(subquery);
}

/**
 * `every` — the absence of ANY collection member that fails the COMPLETE tagged
 * predicate. Two conjuncts, and both are load-bearing:
 *
 * 1. no member of the SELECTED arm violates the target predicate. Read
 *    membership-FIRST through a LEFT JOIN: an orphan cannot satisfy `P`, so a
 *    membership row whose target is missing IS a violation and must not be
 *    dropped by an inner join;
 * 2. no member of ANY OTHER configured arm exists at all — "a member of another
 *    variant does not satisfy the tagged predicate" (plan §7.3).
 *
 * This is deliberately NOT `RelationFilterSubqueries.build(…, negateInner: true)`.
 * That lowering negates only the inner where and leaves the traversal conditions
 * outside the `NOT`, which computes "every post satisfies P WHILE OTHER VARIANTS
 * ARE ALLOWED" — a silently wrong truth table rather than an error, and the exact
 * reading the plan says must not emerge accidentally from `NOT EXISTS` spelling.
 * That reading has its own public spelling: `none: { type, isNot: P }`.
 *
 * `every: { type }` with no predicate reduces to conjunct 2 alone. It does NOT
 * short-circuit to `undefined` the way the ordinary `every` does — "every member
 * is a post" is a real, falsifiable condition. Both conjuncts are `NOT EXISTS`,
 * so `every` stays vacuously true on an empty collection.
 */
function buildEveryCondition(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  arms: readonly MemberArm[],
  selected: MemberArm,
  tagged: Readonly<Record<string, unknown>>
): Sql {
  const { adapter } = ctx;
  const conditions: Sql[] = [];

  const predicate = buildTargetPredicate(
    buildNestedWhere,
    ctx,
    selected,
    tagged
  );
  if (predicate) {
    const [correlationCondition, joinCondition] =
      selected.traversal.conditions();
    const violation = adapter.operators.or(
      buildPolymorphicMemberOrphanProbe(
        ctx,
        selected.membership,
        selected.traversal.targetAlias
      ),
      adapter.operators.not(predicate)
    );
    conditions.push(
      adapter.filters.every(
        wrapMutationTarget(
          ctx,
          adapter.subqueries.existsCheck(
            buildPolymorphicMemberOuterFrom(
              ctx,
              selected.membership,
              joinCondition,
              selected.traversal.junctionAlias,
              selected.traversal.targetAlias
            ),
            adapter.operators.and(correlationCondition, violation)
          ),
          selected.traversal.tables()
        )
      )
    );
  }

  for (const arm of arms) {
    if (arm === selected) continue;
    const [correlationCondition] = arm.traversal.conditions();
    conditions.push(
      adapter.filters.every(
        wrapMutationTarget(
          ctx,
          adapter.subqueries.existsCheck(
            adapter.identifiers.table(
              arm.membership.table,
              arm.traversal.junctionAlias
            ),
            correlationCondition
          ),
          [arm.membership.table]
        )
      )
    );
  }

  return adapter.operators.and(...conditions);
}

/**
 * MySQL error 1093: hide a subquery that selects from the table this statement
 * mutates behind a derived table. A collection filter reads BOTH the member
 * junction and the variant target, and `traversal.tables()` already answers with
 * both — this route is what makes that mechanism reachable for a collection.
 */
function wrapMutationTarget(
  ctx: QueryScope,
  subquery: Sql,
  tables: readonly string[]
): Sql {
  return readsMutationTarget(ctx, tables)
    ? hideMutationTarget(ctx, subquery)
    : subquery;
}

/**
 * Build a direct polymorphic collection `_count`.
 *
 * - UNFILTERED (`config === true`): the sum of one correlated membership count
 *   per member table, folded in DECLARATION ORDER. Membership only — no target
 *   join, per plan §8.4 ("sums correlated counts from all member tables").
 * - FILTERED (`{ where: { type, is|isNot } }`): exactly one arm, counted through
 *   that arm's ordinary junction traversal with the predicate inside.
 *
 * ONE function, called from BOTH the `_count` projection and the `_count`
 * ordering, which is what guarantees plan §8.4's "count ordering uses the same
 * summed expression and one parameter order".
 */
export function buildPolymorphicCollectionCount(
  buildNestedWhere: BuildNestedWhere,
  ctx: QueryScope,
  relation: PolymorphicToManyRelationInfo,
  config: unknown,
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const arms = buildMemberArms(ctx, relation, parentAlias);
  const where =
    isRecord(config) && isRecord(config.where) ? config.where : undefined;

  if (where) {
    const publicType = String(where.type);
    const selected = arms.find((arm) => arm.publicType === publicType);
    if (!selected) {
      throw new QueryEngineError(
        `Unknown polymorphic target '${publicType}' for relation '${relation.name}'.`
      );
    }
    const conditions: Sql[] = [...selected.traversal.conditions()];
    const predicate = buildTargetPredicate(
      buildNestedWhere,
      ctx,
      selected,
      where
    );
    if (predicate) conditions.push(predicate);
    return adapter.subqueries.scalar(
      adapter.assemble.select({
        columns: adapter.aggregates.count(),
        from: selected.traversal.from(),
        where: adapter.operators.and(...conditions),
      })
    );
  }

  const counts = arms.map((arm) =>
    adapter.subqueries.scalar(
      adapter.assemble.select({
        columns: adapter.aggregates.count(),
        from: adapter.identifiers.table(
          arm.membership.table,
          arm.traversal.junctionAlias
        ),
        where: arm.traversal.conditions()[0],
      })
    )
  );
  const [first, ...rest] = counts;
  if (!first) {
    throw new QueryEngineError(
      `Polymorphic collection '${relation.name}' has no configured variants to count.`
    );
  }
  return rest.reduce(
    (total, count) => adapter.expressions.add(total, count),
    first
  );
}
