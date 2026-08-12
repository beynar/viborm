/**
 * Relation OrderBy Builder
 *
 * Builds relation order expressions for top-level SELECT queries.
 */

import type { Sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  createChildScope,
  getColumnName,
  getRelationInfo,
  isRelation,
  isScalarField,
} from "../context";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";
import { buildRelationCount } from "./relation-count-builder";
import { buildRelationTraversal } from "./relation-traversal";
import { buildSingleOrder } from "./sort-order-builder";

export interface RelationOrderAlias {
  alias: string;
  join: Sql;
}

/**
 * Maximum number of to-one relation hops an `orderBy` chain may cross.
 *
 * MIRROR of MAX_RELATION_ORDER_DEPTH in src/validation/relations/order-by.ts,
 * which is the front line — the orderBy schema simply stops offering relation
 * keys past the cap, so an over-deep chain is rejected there as an unknown key.
 * This check is the engine's defense in depth. The two constants must stay
 * equal; tests/query-engine/orderby-relation-depth.test.ts pins that they do.
 *
 * Raised 3 -> 8 by decision D-5 (docs/architecture/prisma-parity-v2-plan.md).
 */
const MAX_RELATION_ORDER_DEPTH = 8;

export function buildRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  value: unknown,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>
): Sql[] {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}' must be an object.`
    );
  }

  if (relationInfo.cardinality === "one") {
    return buildToOneRelationOrders(
      ctx,
      relationInfo,
      value,
      parentAlias,
      relationAliases,
      relationInfo.name,
      1
    );
  }

  return buildToManyRelationOrders(ctx, relationInfo, value, parentAlias);
}

function buildToOneRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  orderBy: Record<string, unknown>,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>,
  relationPath: string,
  depth: number
): Sql[] {
  if (depth > MAX_RELATION_ORDER_DEPTH) {
    throw new QueryEngineError(
      `Relation orderBy path '${relationPath}' exceeds maximum depth of ${MAX_RELATION_ORDER_DEPTH} relation hops.`
    );
  }

  const orders: Sql[] = [];
  const relatedAlias = getRelationOrderAlias(
    ctx,
    relationInfo,
    parentAlias,
    relationAliases,
    relationPath
  ).alias;
  const targetCtx = createChildScope(
    ctx,
    relationInfo.targetModel,
    relatedAlias
  );

  for (const [field, value] of Object.entries(orderBy)) {
    if (value === undefined) {
      continue;
    }

    const fieldPath = `${relationPath}.${field}`;

    if (isRelation(relationInfo.targetModel, field)) {
      const nestedRelationInfo = getRelationInfo(targetCtx, field);
      if (!nestedRelationInfo) {
        throw new QueryEngineError(
          `Unknown relation orderBy field '${fieldPath}'.`
        );
      }

      if (nestedRelationInfo.cardinality === "many") {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' cannot order through a to-many relation; use '_count'.`
        );
      }

      if (!isRecord(value)) {
        throw new QueryEngineError(
          `Relation orderBy '${fieldPath}' must be an object.`
        );
      }

      orders.push(
        ...buildToOneRelationOrders(
          targetCtx,
          nestedRelationInfo,
          value,
          relatedAlias,
          relationAliases,
          fieldPath,
          depth + 1
        )
      );
      continue;
    }

    if (!isScalarField(relationInfo.targetModel, field)) {
      throw new QueryEngineError(
        `Unknown relation orderBy field '${fieldPath}'.`
      );
    }

    // Ordered on the RELATED model's column, so the gate is asked against the
    // related model's scope — a decimal one hop away sorts by bytes exactly as
    // wrongly as a local one.
    assertExactDecimalOperation(targetCtx, field, "orderBy", fieldPath);

    const columnName = getColumnName(relationInfo.targetModel, field);
    const column = ctx.adapter.identifiers.column(relatedAlias, columnName);
    const scalar = relationInfo.targetModel["~"].state.scalars[field];
    orders.push(
      buildSingleOrder(ctx, column, value, {
        name: fieldPath,
        scalarState: scalar?.["~"].state,
      })
    );
  }

  if (orders.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationPath}' requires at least one scalar field.`
    );
  }

  return orders;
}

function getRelationOrderAlias(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>,
  relationPath: string
): RelationOrderAlias {
  const existing = relationAliases.get(relationPath);
  if (existing) {
    return existing;
  }

  // The same physical traversal every other read builder takes, joined instead of
  // selected from: a to-one chain hops through a LEFT JOIN so an absent related
  // row still yields a row. Only to-one relations reach here (`buildRelationOrders`
  // sends to-many chains to `buildRelationCount`), so the fold below always folds
  // the ordinary arm's single pre-folded correlation and leaves it unchanged.
  const traversal = buildRelationTraversal(ctx, relationInfo, parentAlias);
  const relatedAlias = traversal.targetAlias;
  const join = ctx.adapter.joins.left(
    traversal.from(),
    ctx.adapter.operators.and(...traversal.conditions())
  );
  const entry = { alias: relatedAlias, join };
  relationAliases.set(relationPath, entry);
  return entry;
}

function buildToManyRelationOrders(
  ctx: QueryScope,
  relationInfo: RelationInfo,
  orderBy: Record<string, unknown>,
  parentAlias: string
): Sql[] {
  const definedEntries = Object.entries(orderBy).filter(
    ([, value]) => value !== undefined
  );

  if (definedEntries.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}' requires _count.`
    );
  }

  for (const [field] of definedEntries) {
    if (field !== "_count") {
      throw new QueryEngineError(
        `Relation orderBy '${relationInfo.name}.${field}' is not supported. Use '${relationInfo.name}._count' instead.`
      );
    }
  }

  const countOrder = orderBy._count;
  if (countOrder !== "asc" && countOrder !== "desc") {
    throw new QueryEngineError(
      `Relation orderBy '${relationInfo.name}._count' must be 'asc' or 'desc'.`
    );
  }

  const countSql = buildRelationCount(ctx, relationInfo, true, parentAlias);
  return [buildSingleOrder(ctx, countSql, countOrder)];
}
