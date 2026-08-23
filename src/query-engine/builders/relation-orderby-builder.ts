/**
 * Relation OrderBy Builder
 *
 * Builds relation order expressions for top-level SELECT queries.
 */

import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  createChildScope,
  getColumnName,
  isScalarField,
  lookupRelation,
} from "../context";
import {
  QueryEngineError,
  type QueryScope,
  type RelationRef,
  type VariantJunctionCarrierSlot,
} from "../types";
import { assertExactDecimalOperation } from "./decimal-portability";
import {
  buildPolymorphicRelationCount,
  buildRelationCount,
} from "./relation-count-builder";
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
  relationRef: RelationRef,
  value: unknown,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>
): Sql[] {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation orderBy '${relationRef.name}' must be an object.`
    );
  }

  if (relationRef.cardinality === "one") {
    return buildToOneRelationOrders(
      ctx,
      relationRef,
      value,
      parentAlias,
      relationAliases,
      relationRef.name,
      1
    );
  }

  return buildToManyRelationOrders(ctx, relationRef, value, parentAlias);
}

function buildToOneRelationOrders(
  ctx: QueryScope,
  relationRef: RelationRef,
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
    relationRef,
    parentAlias,
    relationAliases,
    relationPath
  ).alias;
  const targetCtx = createChildScope(
    ctx,
    relationRef.targetModel,
    relatedAlias
  );

  for (const [field, value] of Object.entries(orderBy)) {
    if (value === undefined) {
      continue;
    }

    const fieldPath = `${relationPath}.${field}`;

    const nestedRelationRef = lookupRelation(targetCtx, field);
    if (nestedRelationRef) {
      if (nestedRelationRef.cardinality === "many") {
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
          nestedRelationRef,
          value,
          relatedAlias,
          relationAliases,
          fieldPath,
          depth + 1
        )
      );
      continue;
    }

    if (!isScalarField(relationRef.targetModel, field)) {
      throw new QueryEngineError(
        `Unknown relation orderBy field '${fieldPath}'.`
      );
    }

    // Ordered on the RELATED model's column, so the gate is asked against the
    // related model's scope — a decimal one hop away sorts by bytes exactly as
    // wrongly as a local one.
    assertExactDecimalOperation(targetCtx, field, "orderBy", fieldPath);

    const columnName = getColumnName(relationRef.targetModel, field);
    const column = ctx.adapter.identifiers.column(relatedAlias, columnName);
    const scalar = relationRef.targetModel["~"].state.scalars[field];
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
  relationRef: RelationRef,
  parentAlias: string,
  relationAliases: Map<string, RelationOrderAlias>,
  relationPath: string
): RelationOrderAlias {
  const existing = relationAliases.get(relationPath);
  if (existing) {
    return existing;
  }

  // The same physical traversal every other read builder takes, joined instead
  // of selected from: a to-one chain hops through OUTER JOINS so an absent
  // related row still yields a row, with ordinary NULL placement preserved.
  //
  // The traversal owns the lowering, and it is CARDINALITY-NEUTRAL: a row-held
  // edge answers with one join, a junction edge with two (source to member
  // table, then member table to target). Folding a junction into one join was
  // never possible — its FROM is a comma pair, so `LEFT JOIN (a, b) ON (…)` is
  // not a statement — which is why a singular polymorphic inverse reaching here
  // needs the traversal's own answer rather than this builder's.
  const traversal = buildRelationTraversal(ctx, relationRef, parentAlias);
  const entry = {
    alias: traversal.targetAlias,
    join: sql.join(traversal.joins(), " "),
  };
  relationAliases.set(relationPath, entry);
  return entry;
}

function buildToManyRelationOrders(
  ctx: QueryScope,
  relationRef: RelationRef,
  orderBy: Record<string, unknown>,
  parentAlias: string
): Sql[] {
  const definedEntries = Object.entries(orderBy).filter(
    ([, value]) => value !== undefined
  );

  if (definedEntries.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relationRef.name}' requires _count.`
    );
  }

  for (const [field] of definedEntries) {
    if (field !== "_count") {
      throw new QueryEngineError(
        `Relation orderBy '${relationRef.name}.${field}' is not supported. Use '${relationRef.name}._count' instead.`
      );
    }
  }

  const countOrder = orderBy._count;
  if (countOrder !== "asc" && countOrder !== "desc") {
    throw new QueryEngineError(
      `Relation orderBy '${relationRef.name}._count' must be 'asc' or 'desc'.`
    );
  }

  const countSql = buildRelationCount(ctx, relationRef, true, parentAlias);
  return [buildSingleOrder(ctx, countSql, countOrder)];
}

/**
 * Order a parent by a direct polymorphic COLLECTION's `_count`.
 *
 * Its only legal shape is `{ _count: "asc" | "desc" }` — there is no global
 * heterogeneous scalar order across unrelated variant targets — and the count
 * expression is the SAME summed expression the `_count` projection emits.
 */
export function buildPolymorphicRelationOrders(
  ctx: QueryScope,
  relation: VariantJunctionCarrierSlot,
  value: unknown,
  parentAlias: string
): Sql[] {
  if (!isRecord(value)) {
    throw new QueryEngineError(
      `Relation orderBy '${relation.slot.field}' must be an object.`
    );
  }
  const definedEntries = Object.entries(value).filter(
    ([, entry]) => entry !== undefined
  );
  if (definedEntries.length === 0) {
    throw new QueryEngineError(
      `Relation orderBy '${relation.slot.field}' requires _count.`
    );
  }
  for (const [field] of definedEntries) {
    if (field !== "_count") {
      throw new QueryEngineError(
        `Relation orderBy '${relation.slot.field}.${field}' is not supported. Use '${relation.slot.field}._count' instead.`
      );
    }
  }
  const countOrder = value._count;
  if (countOrder !== "asc" && countOrder !== "desc") {
    throw new QueryEngineError(
      `Relation orderBy '${relation.slot.field}._count' must be 'asc' or 'desc'.`
    );
  }
  return [
    buildSingleOrder(
      ctx,
      buildPolymorphicRelationCount(ctx, relation, true, parentAlias),
      countOrder
    ),
  ];
}
