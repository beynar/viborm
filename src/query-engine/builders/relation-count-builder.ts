/**
 * Relation Count Builder
 *
 * Builds correlated COUNT subqueries for relation projections and ordering.
 */

import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import { createChildScope } from "../context";
import {
  QueryEngineError,
  type QueryScope,
  type RelationRef,
  type VariantJunctionCarrierSlot,
} from "../types";
import { buildPolymorphicCollectionCount } from "./polymorphic-collection-filter-builder";
import type { BuildNestedWhere } from "./relation-filter-builder";
import { buildRelationTraversal } from "./relation-traversal";
import { buildWhere } from "./where-builder";

const getWhereConfig = (
  config: unknown
): Record<string, unknown> | undefined => {
  if (!(isRecord(config) && "where" in config)) {
    return undefined;
  }

  if (!isRecord(config.where)) {
    throw new QueryEngineError("Relation count where clause must be an object");
  }

  return config.where;
};

/**
 * Build a COUNT subquery for a relation.
 *
 * @param ctx - Query context
 * @param relationRef - Relation metadata
 * @param config - true or { where: ... }
 * @param parentAlias - Parent table alias
 * @returns SQL for COUNT subquery
 */
export function buildRelationCount(
  ctx: QueryScope,
  relationRef: RelationRef,
  config: unknown,
  parentAlias: string
): Sql {
  const { adapter } = ctx;

  // One traversal counts either shape: a junction count reads junction + target
  // and carries the junction join as its own conjunct.
  const traversal = buildRelationTraversal(ctx, relationRef, parentAlias);
  const { targetAlias } = traversal;
  const conditions: Sql[] = [...traversal.conditions()];

  const rawWhere = getWhereConfig(config);
  if (rawWhere) {
    const childCtx = createChildScope(
      ctx,
      relationRef.targetModel,
      targetAlias
    );
    const innerWhere = buildWhere(childCtx, rawWhere, targetAlias);
    if (innerWhere) {
      conditions.push(innerWhere);
    }
  }

  const whereCondition = adapter.operators.and(...conditions);

  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.aggregates.count()),
        adapter.clauses.from(traversal.from()),
        adapter.clauses.where(whereCondition),
      ],
      " "
    )
  );
}

/** The nested-where seam a collection count compiles its tagged predicate through. */
const buildNestedWhere: BuildNestedWhere = (ctx, where) =>
  buildWhere(ctx, where, ctx.rootAlias);

/**
 * Count one direct polymorphic COLLECTION.
 *
 * The ONE entry both count owners take — the `_count` projection and the
 * `_count` parent ordering — so the summed expression and its parameter order
 * are the same in both statements by construction (plan §8.4).
 */
export function buildPolymorphicRelationCount(
  ctx: QueryScope,
  relation: VariantJunctionCarrierSlot,
  config: unknown,
  parentAlias: string
): Sql {
  return buildPolymorphicCollectionCount(
    buildNestedWhere,
    ctx,
    relation,
    config,
    parentAlias
  );
}
