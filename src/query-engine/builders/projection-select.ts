/**
 * The ONE emitter of a SELECT list (pattern-engine-ideal-state.md §9.1).
 *
 * A projection is walked here and nowhere else: scalars and their transports,
 * the computed `_distance`, relation projections through the physical
 * traversal (lateral or correlated, row-held or own-row), variant arms,
 * `_count`, and the nested window, filter and order each of those carries.
 * `pattern/match.ts` assembles statements around it; the write engine's
 * terminal projection (`matchWriteResult`) rides the same walk.
 *
 * It sits BELOW `builders/select-builder.ts` and
 * `operations/mutation-projection-fold.ts` on purpose: both of those will call
 * it, and `match.ts` already imports the fold, so an emitter living in
 * `match.ts` would close a cycle.
 *
 * ---------------------------------------------------------------------------
 * P2 — THE REWIRING THIS MODULE EXISTS FOR (M5's instruction sheet)
 * ---------------------------------------------------------------------------
 *
 * Today two emitters coexist: this one, and `select-builder.ts`'s own walk over
 * `select` / `include`. P1 (done) moved this one here and gave it the public
 * surface a legacy caller can use unchanged. P2 is rewiring plus deletion, and
 * it must NOT happen before the packer signs off — it puts every legacy read
 * through this lowering, which is the M5 swap.
 *
 * P2 is: `buildSelect` / `buildSelectWithAliases` / `buildMutationProjectionFold`
 * convert their args once through `argsToProjection` (construct-read's own
 * projection walk, ~40 lines of glue) and call the entries below. The 17
 * production call sites are mechanical — `create.ts` (2), `update.ts` (2),
 * `delete.ts` (2), `upsert.ts`, `JunctionStatements.ts`, `find-common.ts`,
 * `find-unique.ts`, `mutation-projection-fold.ts`, `CreateOperation` (2),
 * `UpdateOperation`, `UpsertOperation` — and every one of them holds validated
 * `select` / `include` plus a model, so each can build its projection at the
 * parse boundary.
 *
 * What P2 then retires, having lost its only caller:
 *
 * | module                                   | lines |
 * |------------------------------------------|-------|
 * | `builders/include-builder.ts`            |   361 |
 * | `builders/include-many-to-many.ts`       |   301 |
 * | `builders/polymorphic-collection-read-builder.ts` | 243 |
 * | `builders/nested-read-window.ts`         |    90 |
 * | `buildPolymorphicRead` (polymorphic-read-builder) | ~100 |
 * | `select-builder.ts`'s own walk           |  ~300 |
 *
 * `relation-count-builder.ts` and `buildPolymorphicFilterSql` SURVIVE: the
 * ordering builder and the where builder are their other callers.
 *
 * THE CONSTRAINT THAT DECIDES P2's SHAPE: about 45 white-box contract call
 * sites (`polymorphic-read-sql` 25, `polymorphic-inverse-read-sql` 9,
 * `select-builder-boundaries` 6, `query-builder-coverage-boundaries` 4,
 * `vector-orderby` 1) call the args entry points directly. They survive only
 * if `buildSelect` / `buildSelectWithAliases` / `buildMutationProjectionFold`
 * KEEP their args signatures as adapters over these entries. Changing those
 * signatures instead means rewriting those 45 sites in the same commit.
 */

import { assembleAdapterSelect } from "@adapters/adapter-internals";
import type { Model } from "@schema/model";
import { getModelKeyCatalog } from "@schema/model";
import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  buildDistanceExpression,
  buildPointDistancePredicate,
} from "../builders/distance-builder";
import { buildDistinctColumns } from "../builders/distinct-builder";
import { buildGeoPointWithin } from "../builders/geo-point-builder";
import { assembleInnerQuery } from "../builders/include-query";
import {
  buildPolymorphicMemberIntegrityParts,
  buildPolymorphicMemberOrphanProbe,
  buildPolymorphicMemberOuterFrom,
} from "../builders/polymorphic-member-join-parts";
import { selectVariantRow } from "../builders/polymorphic-relation";
import {
  bindRelation,
  polymorphicMemberMembership,
} from "../builders/relation-data-builder";
import {
  buildMembershipJunctionTraversal,
  buildRelationTraversal,
  type JunctionRelationTraversal,
} from "../builders/relation-traversal";
import { projectScalarForTransport } from "../builders/scalar-transport";
import { buildSingleOrder } from "../builders/sort-order-builder";
import { buildScalarSqlValue } from "../builders/values-builder";
import { buildWhere } from "../builders/where-builder";
import {
  createChildScope,
  getColumnName,
  getScalarFieldNames,
  getTableName,
  lookupRelation,
  variantCarrier,
} from "../context";
import { buildNormalizedOrderBy } from "../operations/cursor-order";
import { buildFindPagination } from "../operations/find-pagination";
import type {
  Extension,
  OrderTerm,
  Pattern,
  Predicate,
  Projection,
  Row,
  Variable,
  Window,
} from "../pattern/pattern";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  POLYMORPHIC_COLLECTION_ARMS_KEY,
  POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY,
  POLYMORPHIC_COLLECTION_ORPHANS_KEY,
  POLYMORPHIC_COLLECTION_ROWS_KEY,
  POLYMORPHIC_RESULT_STATE_COLLECTION,
  POLYMORPHIC_RESULT_STATE_INVALID,
  POLYMORPHIC_RESULT_STATE_KEY,
  POLYMORPHIC_RESULT_STATE_LINKED,
  RELATION_COUNTS_RESULT_KEY,
} from "../result-aliases";
import {
  isVariantRowCarrier,
  QueryEngineError,
  type QueryScope,
  type RelationRef,
  type VariantJunctionCarrierSlot,
  type VariantRowCarrierSlot,
} from "../types";

export function rootRow(pattern: Pattern): Row {
  const row = pattern.rows.find((r) => r.id === pattern.root);
  if (!row) throw new QueryEngineError("pattern match: no root row.");
  return row;
}

export function projectionOf(pattern: Pattern): Projection {
  return (
    pattern.projection ?? { scalars: [], relations: [], relationCounts: [] }
  );
}

export const literalValue = (variable: Variable): unknown =>
  variable.binding.kind === "literal" ? variable.binding.value : undefined;

const operandValue = (operand: Variable | readonly Variable[]): unknown =>
  Array.isArray(operand)
    ? (operand as readonly Variable[]).map(literalValue)
    : literalValue(operand as Variable);

const fieldCache = new WeakMap<Model<any>, Map<string, string>>();

/** The public field behind a physical column of one model. */
export function fieldOf(model: Model<any>, column: string): string {
  let byColumn = fieldCache.get(model);
  if (!byColumn) {
    byColumn = new Map(
      getScalarFieldNames(model).map((field) => [
        getColumnName(model, field),
        field,
      ])
    );
    fieldCache.set(model, byColumn);
  }
  return byColumn.get(column) ?? column;
}

export const fieldOfExtension = (extension: Extension): string =>
  extension.reference.relation.field;

export function requireRelationRef(
  ctx: QueryScope,
  field: string
): RelationRef {
  const ref = lookupRelation(ctx, field);
  if (!ref) {
    throw new QueryEngineError(`pattern match: unknown relation '${field}'.`);
  }
  return ref;
}
// ---------------------------------------------------------------------------
// Window → the pagination owner's public inputs
// ---------------------------------------------------------------------------

/**
 * The order terms in the public spelling `buildFindPagination` normalizes: one
 * single-key item per term. Only scalar-ness and direction are read from it.
 */
export function orderTermsAsArgs(
  model: Model<any>,
  window: Window
): Record<string, unknown>[] | undefined {
  const items: Record<string, unknown>[] = [];
  for (const term of window.orderBy as readonly OrderTerm[]) {
    switch (term.kind) {
      case "scalar":
        items.push({
          [fieldOf(model, term.column)]: term.nulls
            ? { sort: term.direction, nulls: term.nulls }
            : term.direction,
        });
        break;
      case "structural":
        items.push({
          [fieldOf(model, term.column)]: literalValue(term.operand),
        });
        break;
      case "relationScalar": {
        let nested: Record<string, unknown> = {
          [term.column]: term.nulls
            ? { sort: term.direction, nulls: term.nulls }
            : term.direction,
        };
        for (const hop of [...term.path].reverse()) {
          nested = { [fieldOfExtension(hop)]: nested };
        }
        items.push(nested);
        break;
      }
      case "relationAggregate":
        items.push({
          [fieldOfExtension(term.extension)]: { _count: term.direction },
        });
        break;
      case "aggregate":
        items.push({ [term.aggregate]: { [term.field]: term.direction } });
        break;
      default:
        break;
    }
  }
  return items.length > 0 ? items : undefined;
}

/** The cursor's whereUnique, regrouped into the model's addressable keys. */
export function cursorAsArgs(
  model: Model<any>,
  window: Window
): Record<string, unknown> {
  return keyAsWhereUnique(model, window.cursor?.key ?? []);
}

export function keyAsWhereUnique(
  model: Model<any>,
  key: readonly Variable[]
): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  const { addressableKeys } = getModelKeyCatalog(model);
  const fields = key.map((variable) => variable.scalar?.field ?? "");
  let at = 0;
  while (at < key.length) {
    const field = fields[at]!;
    const bare = addressableKeys.find(
      (candidate) =>
        candidate.name === undefined &&
        candidate.fields.length === 1 &&
        candidate.fields[0] === field
    );
    if (bare) {
      where[field] = literalValue(key[at]!);
      at++;
      continue;
    }
    const compound = addressableKeys.find(
      (candidate) =>
        candidate.name !== undefined &&
        candidate.fields.every((member, i) => fields[at + i] === member)
    );
    if (compound?.name) {
      const members: Record<string, unknown> = {};
      compound.fields.forEach((member, i) => {
        members[member] = literalValue(key[at + i]!);
      });
      where[compound.name] = members;
      at += compound.fields.length;
      continue;
    }
    where[field] = literalValue(key[at]!);
    at++;
  }
  return where;
}

// ---------------------------------------------------------------------------
// Projection
// ---------------------------------------------------------------------------

type Strategy = "auto" | "subquery";

export interface Selection {
  readonly sql: Sql;
  readonly aliases: string[];
  readonly lateralJoins: Sql[];
}

function castNumericPairsForJson(
  ctx: QueryScope,
  pairs: [string, Sql][]
): [string, Sql][] {
  const scalars = ctx.model["~"].state.scalars;
  return pairs.map(([field, expr]) => {
    const type = scalars[field]?.["~"].state.type;
    if (type === "bigint") {
      return [field, ctx.adapter.expressions.cast(expr, "text")];
    }
    if (type === "blob")
      return [field, ctx.adapter.expressions.blobToHex(expr)];
    return [field, expr];
  });
}

function selectionSql(
  ctx: QueryScope,
  pairs: [string, Sql][],
  asJson: boolean
): Sql {
  if (asJson) {
    return ctx.adapter.json.objectFromColumns(
      castNumericPairsForJson(ctx, pairs)
    );
  }
  return sql.join(
    pairs.map(([name, expr]) => ctx.adapter.identifiers.aliased(expr, name)),
    ", "
  );
}

/** A nested row's JSON selection: the same pairs, as one JSON object. */
function nestedSelection(
  ctx: QueryScope,
  pattern: Pattern,
  strategy: Strategy
): { sql: Sql; lateralJoins: Sql[] } {
  const { pairs, lateralJoins } = selectPairs(
    ctx,
    projectionOf(pattern),
    ctx.rootAlias,
    strategy
  );
  return { sql: selectionSql(ctx, pairs, true), lateralJoins };
}

export function lowerProjection(
  ctx: QueryScope,
  projection: Projection,
  alias: string,
  strategy: Strategy
): Selection {
  const { pairs, lateralJoins } = selectPairs(ctx, projection, alias, strategy);
  return {
    sql: selectionSql(ctx, pairs, false),
    aliases: pairs.map(([name]) => name),
    lateralJoins,
  };
}

function selectPairs(
  ctx: QueryScope,
  projection: Projection,
  alias: string,
  strategy: Strategy
): { pairs: [string, Sql][]; lateralJoins: Sql[] } {
  const { adapter, model } = ctx;
  const pairs: [string, Sql][] = [];
  const lateralJoins: Sql[] = [];
  const scalars = model["~"].state.scalars;
  const selected = new Set(projection.scalars);
  const distance = projection.computed?.find((c) => c.form === "distance");
  const distanceField = distance
    ? String(literalValue(distance.operands[0]!))
    : undefined;

  // Scalars and the computed distance interleave in MODEL order, as the select
  // owner walks them.
  for (const field of getScalarFieldNames(model)) {
    const column = adapter.identifiers.column(
      alias,
      getColumnName(model, field)
    );
    if (selected.has(field)) {
      const scalar = scalars[field];
      const type = scalar?.["~"].state.type;
      pairs.push([
        field,
        type === "decimal" || type === "point"
          ? projectScalarForTransport(adapter, scalar, column)
          : column,
      ]);
      continue;
    }
    if (distance && field === distanceField) {
      pairs.push([
        DISTANCE_RESULT_KEY,
        buildDistanceExpression(
          ctx,
          column,
          literalValue(distance.operands[1]!),
          { name: field, scalarState: scalars[field]?.["~"].state },
          "select"
        ),
      ]);
    }
  }

  // Relations, grouped by field: a variant slot's arms are consecutive entries.
  const relations = projection.relations;
  for (let i = 0; i < relations.length; ) {
    const field = relations[i]!.field;
    let end = i + 1;
    while (end < relations.length && relations[end]!.field === field) end++;
    const arms = relations.slice(i, end);
    i = end;
    const carrier = variantCarrier(ctx, field);
    if (carrier) {
      pairs.push([field, lowerVariantProjection(ctx, carrier, arms, alias)]);
      continue;
    }
    const include = lowerInclude(ctx, arms[0]!.extension, alias, strategy);
    pairs.push([field, include.column]);
    if (include.lateralJoin) lateralJoins.push(include.lateralJoin);
  }

  if (projection.relationCounts.length > 0) {
    pairs.push([
      RELATION_COUNTS_RESULT_KEY,
      adapter.json.objectFromColumns(
        projection.relationCounts.map(({ field, extension }) => [
          field,
          lowerCount(ctx, extension, alias),
        ])
      ),
    ]);
  }

  if (pairs.length === 0) {
    pairs.push([
      EMPTY_ROW_RESULT_KEY,
      adapter.expressions.cast(adapter.literals.value(1), "integer"),
    ]);
  }
  return { pairs, lateralJoins };
}

// ---------------------------------------------------------------------------
// Includes — one call site above the traversal
// ---------------------------------------------------------------------------

interface IncludeColumn {
  readonly column: Sql;
  readonly lateralJoin?: Sql;
}

function lowerInclude(
  ctx: QueryScope,
  extension: Extension,
  parentAlias: string,
  strategy: Strategy
): IncludeColumn {
  const parentScope =
    parentAlias === ctx.rootAlias
      ? ctx
      : createChildScope(ctx, ctx.model, parentAlias);
  const relationRef = requireRelationRef(
    parentScope,
    fieldOfExtension(extension)
  );
  const lateral =
    strategy !== "subquery" &&
    parentScope.adapter.capabilities.supportsLateralJoins;
  return lateral
    ? lateralInclude(parentScope, relationRef, extension.target)
    : subqueryInclude(parentScope, relationRef, extension.target);
}

function subqueryInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  target: Pattern
): IncludeColumn {
  const { adapter } = ctx;
  const traversal = buildRelationTraversal(ctx, relationRef, ctx.rootAlias);
  if (traversal.kind === "junction") {
    if (traversal.cardinality() === "one") {
      return {
        column: singularOwnRowInclude(ctx, relationRef, target, traversal),
      };
    }
    return { column: ownRowInclude(ctx, relationRef, target, traversal) };
  }
  const relatedAlias = traversal.targetAlias;
  const childCtx = createChildScope(ctx, relationRef.targetModel, relatedAlias);
  const jsonExpr = nestedSelection(childCtx, target, "subquery").sql;
  const baseConditions = traversal.conditions();
  const fromTable = traversal.from();
  if (traversal.relation().cardinality === "many") {
    const window = nestedWindow(childCtx, target, relatedAlias, baseConditions);
    return { column: toManySubquery(ctx, jsonExpr, fromTable, window) };
  }
  const conditions: Sql[] = [...baseConditions];
  const innerWhere = lowerPredicate(
    childCtx,
    rootRow(target).predicate,
    relatedAlias,
    true
  );
  if (innerWhere) conditions.push(innerWhere);
  return {
    column: adapter.subqueries.scalar(
      assembleInnerQuery(adapter, {
        selectExpr: jsonExpr,
        from: fromTable,
        where: adapter.operators.and(...conditions),
        take: 1,
      })
    ),
  };
}

function lateralInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  target: Pattern
): IncludeColumn {
  const { adapter } = ctx;
  const traversal = buildRelationTraversal(ctx, relationRef, ctx.rootAlias);
  if (traversal.kind === "junction") {
    if (traversal.cardinality() === "one") {
      return {
        column: singularOwnRowInclude(ctx, relationRef, target, traversal),
      };
    }
    if (traversal.membership().polymorphicMember) {
      return { column: ownRowInclude(ctx, relationRef, target, traversal) };
    }
    return ownRowLateralInclude(ctx, relationRef, target, traversal);
  }
  const relatedAlias = traversal.targetAlias;
  const lateralAlias = ctx.nextAlias();
  const childCtx = createChildScope(ctx, relationRef.targetModel, relatedAlias);
  const selection = nestedSelection(childCtx, target, "auto");
  const baseConditions = traversal.conditions();
  const fromTable = traversal.from();
  const resultColAlias = "_result";

  if (traversal.relation().cardinality === "many") {
    const window = nestedWindow(childCtx, target, relatedAlias, baseConditions);
    const jsonColAlias = "_json";
    const innerQuery = assembleInnerQuery(adapter, {
      selectExpr: adapter.identifiers.aliased(selection.sql, jsonColAlias),
      from: fromTable,
      joins: [...selection.lateralJoins, ...window.joins],
      where: window.where,
      orderBy: window.orderBy,
      take: window.limit,
      skip: window.offset,
      distinct: window.distinct,
      distinctColumnAliases: [jsonColAlias],
    });
    const innerAlias = ctx.nextAlias();
    const aggExpr = adapter.json.agg(
      adapter.identifiers.column(innerAlias, jsonColAlias)
    );
    const lateralSubquery = sql.join(
      [
        adapter.clauses.select(
          adapter.identifiers.aliased(aggExpr, resultColAlias)
        ),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(innerAlias)}`
        ),
      ],
      " "
    );
    return {
      column: adapter.identifiers.column(lateralAlias, resultColAlias),
      lateralJoin: adapter.joins.lateralLeft(lateralSubquery, lateralAlias),
    };
  }

  const conditions: Sql[] = [...baseConditions];
  const innerWhere = lowerPredicate(
    childCtx,
    rootRow(target).predicate,
    relatedAlias,
    true
  );
  if (innerWhere) conditions.push(innerWhere);
  const lateralSubquery = assembleInnerQuery(adapter, {
    selectExpr: adapter.identifiers.aliased(selection.sql, resultColAlias),
    from: fromTable,
    joins: selection.lateralJoins,
    where: adapter.operators.and(...conditions),
    take: 1,
  });
  return {
    column: adapter.identifiers.column(lateralAlias, resultColAlias),
    lateralJoin: adapter.joins.lateralLeft(lateralSubquery, lateralAlias),
  };
}

interface NestedWindow {
  where: Sql;
  orderBy: Sql | undefined;
  joins: Sql[];
  limit: number | undefined;
  offset: number | undefined;
  distinct: Sql | undefined;
}

/** nested-read-window.ts, with this module's predicate and order lowering. */
export function nestedWindow(
  ctx: QueryScope,
  target: Pattern,
  alias: string,
  baseConditions: readonly Sql[]
): NestedWindow {
  const { adapter } = ctx;
  const window = projectionOf(target).window ?? { orderBy: [] };
  const take = window.take;
  const pagination = buildFindPagination(
    ctx,
    {
      orderBy: orderTermsAsArgs(ctx.model, window),
      ...(window.cursor ? { cursor: cursorAsArgs(ctx.model, window) } : {}),
      ...(window.skip !== undefined ? { skip: window.skip } : {}),
    },
    take,
    alias
  );
  const conditions: Sql[] = [...baseConditions];
  const innerWhere = lowerPredicate(
    ctx,
    rootRow(target).predicate,
    alias,
    true
  );
  if (innerWhere) conditions.push(innerWhere);
  if (pagination.cursorCondition) conditions.push(pagination.cursorCondition);
  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [] as Sql[],
      }
    : lowerOrder(ctx, window, alias, take !== undefined && take < 0);
  return {
    where: adapter.operators.and(...conditions),
    orderBy: orderByParts.orderBy,
    joins: orderByParts.joins,
    limit: take === undefined ? undefined : Math.abs(take),
    offset: window.skip,
    distinct: window.distinct
      ? buildDistinctColumns(ctx, [...window.distinct], alias)
      : undefined,
  };
}

function toManySubquery(
  ctx: QueryScope,
  jsonExpr: Sql,
  fromTable: Sql,
  window: NestedWindow
): Sql {
  const { adapter } = ctx;
  const jsonColAlias = "_json";
  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: adapter.identifiers.aliased(jsonExpr, jsonColAlias),
    from: fromTable,
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });
  const subAlias = ctx.nextAlias();
  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(
          adapter.json.agg(adapter.identifiers.column(subAlias, jsonColAlias))
        ),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
        ),
      ],
      " "
    )
  );
}

/** include-many-to-many.ts `buildManyToManyInclude`, one recursion. */
function ownRowInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  target: Pattern,
  traversal: JunctionRelationTraversal
): Sql {
  const { targetAlias } = traversal;
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);
  const jsonExpr = nestedSelection(childCtx, target, "subquery").sql;
  const window = nestedWindow(
    childCtx,
    target,
    targetAlias,
    traversal.conditions()
  );
  const rows = toManySubquery(ctx, jsonExpr, traversal.from(), window);
  return guardOwnRowIntegrity(
    ctx,
    traversal,
    rows,
    ctx.adapter.json.objectFromColumns([])
  );
}

/** include-many-to-many.ts `buildManyToManyLateralInclude`, one recursion. */
function ownRowLateralInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  target: Pattern,
  traversal: JunctionRelationTraversal
): IncludeColumn {
  const { adapter } = ctx;
  const { targetAlias } = traversal;
  const lateralAlias = ctx.nextAlias();
  const baseConditions = traversal.conditions();
  const fromClause = traversal.from();
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);
  const selection = nestedSelection(childCtx, target, "auto");
  const window = nestedWindow(childCtx, target, targetAlias, baseConditions);
  const jsonColAlias = "_json";
  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: adapter.identifiers.aliased(selection.sql, jsonColAlias),
    from: fromClause,
    joins: [...selection.lateralJoins, ...window.joins],
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });
  const innerAlias = ctx.nextAlias();
  const resultColAlias = "_result";
  const lateralSubquery = sql.join(
    [
      adapter.clauses.select(
        adapter.identifiers.aliased(
          adapter.json.agg(
            adapter.identifiers.column(innerAlias, jsonColAlias)
          ),
          resultColAlias
        )
      ),
      adapter.clauses.from(
        sql`(${innerQuery}) ${adapter.identifiers.escape(innerAlias)}`
      ),
    ],
    " "
  );
  return {
    column: adapter.identifiers.column(lateralAlias, resultColAlias),
    lateralJoin: adapter.joins.lateralLeft(lateralSubquery, lateralAlias),
  };
}

/** include-many-to-many.ts `buildSingularJunctionInclude`, one recursion. */
function singularOwnRowInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  target: Pattern,
  traversal: JunctionRelationTraversal
): Sql {
  const { adapter } = ctx;
  const { targetAlias } = traversal;
  const childCtx = createChildScope(ctx, relationRef.targetModel, targetAlias);
  const jsonExpr = nestedSelection(childCtx, target, "subquery").sql;
  const conditions: Sql[] = [...traversal.conditions()];
  const innerWhere = lowerPredicate(
    childCtx,
    rootRow(target).predicate,
    targetAlias,
    true
  );
  if (innerWhere) conditions.push(innerWhere);
  const row = adapter.subqueries.scalar(
    assembleInnerQuery(adapter, {
      selectExpr: jsonExpr,
      from: traversal.from(),
      where: adapter.operators.and(...conditions),
      take: 1,
    })
  );
  return guardOwnRowIntegrity(ctx, traversal, row, adapter.json.emptyArray());
}

/** include-many-to-many.ts `guardJunctionIntegrity` (module-private there). */
function guardOwnRowIntegrity(
  ctx: QueryScope,
  traversal: JunctionRelationTraversal,
  projected: Sql,
  malformed: Sql
): Sql {
  const membership = traversal.membership();
  if (!membership.polymorphicMember) return projected;
  const { adapter } = ctx;
  const [correlationCondition, joinCondition] = traversal.conditions();
  const membershipCount = adapter.subqueries.scalar(
    assembleAdapterSelect(adapter, {
      columns: adapter.aggregates.count(),
      from: adapter.identifiers.table(
        membership.table,
        traversal.junctionAlias
      ),
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
        traversal.junctionAlias,
        traversal.targetAlias
      ),
      where: adapter.operators.and(
        correlationCondition,
        buildPolymorphicMemberOrphanProbe(
          ctx,
          membership,
          traversal.targetAlias
        )
      ),
    })
  );
  const branches: { readonly when: Sql; readonly then: Sql }[] = [
    {
      when: adapter.operators.gt(orphanCount, adapter.literals.value(0)),
      then: malformed,
    },
  ];
  if (traversal.cardinality() === "one") {
    branches.push({
      when: adapter.operators.gt(membershipCount, adapter.literals.value(1)),
      then: malformed,
    });
  }
  return adapter.expressions.caseWhen(branches, projected);
}

// ---------------------------------------------------------------------------
// Variant projections (row carrier CASE, collection document)
// ---------------------------------------------------------------------------

type RelationEntry = Projection["relations"][number];

function lowerVariantProjection(
  ctx: QueryScope,
  carrier: VariantRowCarrierSlot | VariantJunctionCarrierSlot,
  arms: readonly Projection["relations"][number][],
  parentAlias: string
): Sql {
  const byVariant = new Map(arms.map((arm) => [arm.variant, arm]));
  return isVariantRowCarrier(carrier)
    ? variantRowRead(ctx, carrier, byVariant, parentAlias)
    : variantCollectionRead(ctx, carrier, byVariant, parentAlias);
}

/** polymorphic-read-builder.ts `buildPolymorphicRead`, one recursion. */
function variantRowRead(
  ctx: QueryScope,
  relation: VariantRowCarrierSlot,
  byVariant: ReadonlyMap<string | undefined, RelationEntry>,
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const typeColumn = adapter.identifiers.column(
    parentAlias,
    relation.edge.storage.typeColumn.name
  );
  const idColumn = adapter.identifiers.column(
    parentAlias,
    relation.edge.storage.idColumn.name
  );
  const textLiteral = (value: string) =>
    adapter.expressions.cast(adapter.literals.value(value), "text");
  const branches: { readonly when: Sql; readonly then: Sql }[] = [
    {
      when: adapter.operators.and(
        adapter.operators.isNull(typeColumn),
        adapter.operators.isNull(idColumn)
      ),
      then: adapter.literals.null(),
    },
  ];
  for (const member of relation.edge.members) {
    const publicType = member.variant;
    const edge = selectVariantRow(relation, publicType);
    const targetAlias = ctx.nextAlias();
    const targetScope = createChildScope(
      ctx,
      edge.member.targetModel,
      targetAlias
    );
    const target = byVariant.get(publicType);
    const targetJson = target
      ? nestedSelection(targetScope, target.extension.target, "subquery").sql
      : adapter.json.objectFromColumns([]);
    const targetColumn = adapter.identifiers.column(
      targetAlias,
      getColumnName(edge.member.targetModel, edge.member.referencedField)
    );
    const targetQuery = assembleInnerQuery(adapter, {
      selectExpr: targetJson,
      from: adapter.identifiers.table(
        getTableName(edge.member.targetModel),
        targetAlias
      ),
      where: adapter.operators.eq(targetColumn, idColumn),
      take: 1,
    });
    branches.push({
      when: adapter.operators.and(
        adapter.operators.exactTextEq(
          typeColumn,
          adapter.literals.value(edge.member.entry.storedValue)
        ),
        adapter.operators.isNotNull(idColumn)
      ),
      then: adapter.json.objectFromColumns([
        [
          POLYMORPHIC_RESULT_STATE_KEY,
          textLiteral(POLYMORPHIC_RESULT_STATE_LINKED),
        ],
        ["type", textLiteral(publicType)],
        ["data", adapter.json.document(adapter.subqueries.scalar(targetQuery))],
      ]),
    });
  }
  const invalid = adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      textLiteral(POLYMORPHIC_RESULT_STATE_INVALID),
    ],
    ["storedType", typeColumn],
    ["hasId", adapter.json.boolean(adapter.operators.isNotNull(idColumn))],
  ]);
  return adapter.expressions.caseWhen(branches, invalid);
}

/** polymorphic-collection-read-builder.ts `buildPolymorphicCollectionRead`, one recursion. */
function variantCollectionRead(
  ctx: QueryScope,
  relation: VariantJunctionCarrierSlot,
  byVariant: ReadonlyMap<string | undefined, RelationEntry>,
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const textLiteral = (value: string) =>
    adapter.expressions.cast(adapter.literals.value(value), "text");
  const arms: [string, Sql][] = [];
  for (const member of relation.edge.members) {
    const publicType = member.variant;
    const membership = polymorphicMemberMembership(member.topology, "owner");
    const traversal = buildMembershipJunctionTraversal(
      ctx,
      () => membership,
      "many",
      parentAlias
    );
    const [correlationCondition, joinCondition] = traversal.conditions();
    const integrity = buildPolymorphicMemberIntegrityParts(
      ctx,
      membership,
      correlationCondition,
      joinCondition,
      traversal.junctionAlias,
      traversal.targetAlias
    );
    const entry = byVariant.get(publicType);
    const visible = entry ? entry.visible !== false : false;
    const rows =
      entry && visible
        ? visibleArmRows(
            ctx,
            member.topology.target.model,
            entry.extension.target,
            publicType,
            traversal
          )
        : adapter.literals.null();
    arms.push([
      publicType,
      adapter.json.objectFromColumns([
        [POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY, integrity.membership],
        [POLYMORPHIC_COLLECTION_ORPHANS_KEY, integrity.orphans],
        [POLYMORPHIC_COLLECTION_ROWS_KEY, rows],
      ]),
    ]);
  }
  return adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      textLiteral(POLYMORPHIC_RESULT_STATE_COLLECTION),
    ],
    [
      POLYMORPHIC_COLLECTION_ARMS_KEY,
      adapter.json.document(adapter.json.objectFromColumns(arms)),
    ],
  ]);
}

function visibleArmRows(
  ctx: QueryScope,
  targetModel: Model<any>,
  target: Pattern,
  publicType: string,
  traversal: JunctionRelationTraversal
): Sql {
  const { adapter } = ctx;
  const { targetAlias } = traversal;
  const childCtx = createChildScope(ctx, targetModel, targetAlias);
  const jsonExpr = nestedSelection(childCtx, target, "subquery").sql;
  const linked = adapter.json.objectFromColumns([
    [
      POLYMORPHIC_RESULT_STATE_KEY,
      adapter.expressions.cast(
        adapter.literals.value(POLYMORPHIC_RESULT_STATE_LINKED),
        "text"
      ),
    ],
    [
      "type",
      adapter.expressions.cast(adapter.literals.value(publicType), "text"),
    ],
    ["data", adapter.json.document(jsonExpr)],
  ]);
  const window = nestedWindow(
    childCtx,
    target,
    targetAlias,
    traversal.conditions()
  );
  const jsonColAlias = "_json";
  const innerQuery = assembleInnerQuery(adapter, {
    selectExpr: adapter.identifiers.aliased(linked, jsonColAlias),
    from: traversal.from(),
    joins: window.joins,
    where: window.where,
    orderBy: window.orderBy,
    take: window.limit,
    skip: window.offset,
    distinct: window.distinct,
    distinctColumnAliases: [jsonColAlias],
  });
  const subAlias = ctx.nextAlias();
  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(
          adapter.json.agg(adapter.identifiers.column(subAlias, jsonColAlias))
        ),
        adapter.clauses.from(
          sql`(${innerQuery}) ${adapter.identifiers.escape(subAlias)}`
        ),
      ],
      " "
    )
  );
}

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

interface MemberArm {
  readonly publicType: string;
  readonly traversal: JunctionRelationTraversal;
  readonly membership: ReturnType<typeof polymorphicMemberMembership>;
  readonly targetModel: Model<any>;
}

function memberArms(
  ctx: QueryScope,
  relation: VariantJunctionCarrierSlot,
  parentAlias: string
): MemberArm[] {
  return relation.edge.members.map((member) => {
    const membership = polymorphicMemberMembership(member.topology, "owner");
    return {
      publicType: member.variant,
      membership,
      targetModel: member.topology.target.model,
      traversal: buildMembershipJunctionTraversal(
        ctx,
        () => membership,
        "many",
        parentAlias
      ),
    };
  });
}

function selectArm(
  arms: readonly MemberArm[],
  publicType: string,
  field: string
): MemberArm {
  const arm = arms.find((candidate) => candidate.publicType === publicType);
  if (!arm) {
    throw new QueryEngineError(
      `Unknown polymorphic target '${publicType}' for relation '${field}'.`
    );
  }
  return arm;
}

export function lowerCount(
  ctx: QueryScope,
  extension: Extension,
  parentAlias: string
): Sql {
  const { adapter } = ctx;
  const field = fieldOfExtension(extension);
  const target = extension.target;
  const carrier = variantCarrier(ctx, field);
  if (carrier && !isVariantRowCarrier(carrier)) {
    const arms = memberArms(ctx, carrier, parentAlias);
    const { variant } = extension;
    if (variant !== undefined) {
      const selected = selectArm(arms, variant, field);
      const conditions: Sql[] = [...selected.traversal.conditions()];
      const childCtx = createChildScope(
        ctx,
        selected.targetModel,
        selected.traversal.targetAlias
      );
      const predicate = lowerPredicate(
        childCtx,
        rootRow(target).predicate,
        selected.traversal.targetAlias,
        true
      );
      if (predicate) conditions.push(predicate);
      return adapter.subqueries.scalar(
        assembleAdapterSelect(adapter, {
          columns: adapter.aggregates.count(),
          from: selected.traversal.from(),
          where: adapter.operators.and(...conditions),
        })
      );
    }
    const counts = arms.map((arm) =>
      adapter.subqueries.scalar(
        assembleAdapterSelect(adapter, {
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
        `Polymorphic collection '${field}' has no configured variants to count.`
      );
    }
    return rest.reduce(
      (total, count) => adapter.expressions.add(total, count),
      first
    );
  }
  const relationRef = requireRelationRef(ctx, field);
  const traversal = buildRelationTraversal(ctx, relationRef, parentAlias);
  const conditions: Sql[] = [...traversal.conditions()];
  const predicate = rootRow(target).predicate;
  if (predicate) {
    const childCtx = createChildScope(
      ctx,
      relationRef.targetModel,
      traversal.targetAlias
    );
    const innerWhere = lowerPredicate(
      childCtx,
      predicate,
      traversal.targetAlias,
      true
    );
    if (innerWhere) conditions.push(innerWhere);
  }
  return adapter.subqueries.scalar(
    sql.join(
      [
        adapter.clauses.select(adapter.aggregates.count()),
        adapter.clauses.from(traversal.from()),
        adapter.clauses.where(adapter.operators.and(...conditions)),
      ],
      " "
    )
  );
}

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

function reverseSortValue(value: unknown): unknown {
  if (value === "asc") return "desc";
  if (value === "desc") return "asc";
  if (!isRecord(value)) return value;
  const reversedNulls =
    value.nulls === "first"
      ? "last"
      : value.nulls === "last"
        ? "first"
        : undefined;
  if (value.sort === "asc" || value.sort === "desc") {
    return {
      ...value,
      sort: value.sort === "asc" ? "desc" : "asc",
      ...(reversedNulls ? { nulls: reversedNulls } : {}),
    };
  }
  const reversed: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    reversed[key] = reverseSortValue(member);
  }
  return reversed;
}

/** orderby-builder.ts + relation-orderby-builder.ts, one recursion. */
export function lowerOrder(
  ctx: QueryScope,
  window: Window,
  alias: string,
  reverse: boolean
): { orderBy: Sql | undefined; joins: Sql[] } {
  const { adapter } = ctx;
  const orders: Sql[] = [];
  const relationAliases = new Map<string, { alias: string; join: Sql }>();
  const sortValue = (direction: "asc" | "desc", nulls?: "first" | "last") => {
    const value: unknown = nulls ? { sort: direction, nulls } : direction;
    return reverse ? reverseSortValue(value) : value;
  };

  for (const term of window.orderBy as readonly OrderTerm[]) {
    switch (term.kind) {
      case "scalar": {
        const field = fieldOf(ctx.model, term.column);
        orders.push(
          buildSingleOrder(
            ctx,
            adapter.identifiers.column(alias, term.column),
            sortValue(term.direction, term.nulls),
            {
              name: field,
              scalarState: ctx.model["~"].state.scalars[field]?.["~"].state,
            }
          )
        );
        break;
      }
      case "structural": {
        const field = fieldOf(ctx.model, term.column);
        const raw = literalValue(term.operand);
        orders.push(
          buildSingleOrder(
            ctx,
            adapter.identifiers.column(alias, term.column),
            reverse ? reverseSortValue(raw) : raw,
            {
              name: field,
              scalarState: ctx.model["~"].state.scalars[field]?.["~"].state,
            }
          )
        );
        break;
      }
      case "relationScalar": {
        let hopCtx = ctx;
        let hopAlias = alias;
        let path = "";
        for (const hop of term.path) {
          const field = fieldOfExtension(hop);
          path = path === "" ? field : `${path}.${field}`;
          const relationRef = requireRelationRef(hopCtx, field);
          let entry = relationAliases.get(path);
          if (!entry) {
            const traversal = buildRelationTraversal(
              hopCtx,
              relationRef,
              hopAlias
            );
            entry = {
              alias: traversal.targetAlias,
              join: sql.join(traversal.joins(), " "),
            };
            relationAliases.set(path, entry);
          }
          hopCtx = createChildScope(
            hopCtx,
            relationRef.targetModel,
            entry.alias
          );
          hopAlias = entry.alias;
        }
        const field = fieldOf(hopCtx.model, term.column);
        orders.push(
          buildSingleOrder(
            ctx,
            adapter.identifiers.column(hopAlias, term.column),
            sortValue(term.direction, term.nulls),
            {
              name: `${path}.${field}`,
              scalarState: hopCtx.model["~"].state.scalars[field]?.["~"].state,
            }
          )
        );
        break;
      }
      case "relationAggregate":
        orders.push(
          buildSingleOrder(
            ctx,
            lowerCount(ctx, term.extension, alias),
            reverse ? reverseSortValue(term.direction) : term.direction
          )
        );
        break;
      default:
        throw new QueryEngineError("pattern match: unsupported order term.");
    }
  }
  const joins = [...relationAliases.values()].map((entry) => entry.join);
  return {
    orderBy: orders.length > 0 ? sql.join(orders, ", ") : undefined,
    joins,
  };
}

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/**
 * THE PREDICATE LOWERING — the one entry the packer (D+E) and this module's
 * own SELECTs share for K1 shapes. Nothing here goes through the public-args
 * path, so a K1 `Predicate` or a K1 row key never meets the validator's
 * "must be a filter object" / "requires at least one unique discriminator".
 *
 * - `lowerPredicate(ctx, predicate, alias, polarity?)` lowers one K1
 *   `Predicate` tree on the table aliased `alias`. `ctx` is a `QueryScope`
 *   whose `model` is the row's model and whose `rootAlias` is `alias` for a
 *   root row (`createQueryScope(engine, model)`), or a child scope
 *   (`createChildScope(parent, model, alias)`) for any other row. Scalar
 *   leaves are spelled by the filter owner (`buildWhere` over one field),
 *   structural leaves by their own owners, relation leaves by this module's
 *   traversal recursion (aliases are spent on `ctx.nextAlias()`). `polarity`
 *   is the positive/negative context (`NOT` flips it; it only decides a geo
 *   distance leaf's spelling). Returns `undefined` for an empty tree.
 * - `lowerRowKey(ctx, key, alias)` lowers a row's K1 `key` — literal
 *   variables carrying `scalar.field` — to the conjunction of column
 *   equalities `buildWhereUnique` emits for a discriminator (each operand
 *   bound through `buildScalarSqlValue`). `undefined` for an empty key.
 * - `lowerRowSelector(ctx, row, alias)` is both: the key equalities followed
 *   by the row's predicate, as one `AND` — what a `findUnique` root, a
 *   located write target, or a guard's re-run selects by.
 */
export function lowerPredicate(
  ctx: QueryScope,
  predicate: Predicate | undefined,
  alias: string,
  polarity = true
): Sql | undefined {
  if (!predicate) return undefined;
  const { adapter } = ctx;
  switch (predicate.kind) {
    case "and": {
      const items = predicate.items
        .map((item) => lowerPredicate(ctx, item, alias, polarity))
        .filter((item): item is Sql => item !== undefined);
      // A relation group (the quantifiers of one relation key) is a filter of
      // its own: an `every: {}` that left silently still yields the group's
      // conjunction of nothing, the dialect's TRUE, exactly as the filter
      // owner returns it.
      const relationGroup =
        predicate.items.length > 0 &&
        predicate.items.every((item) => item.kind === "relation");
      if (relationGroup) return adapter.operators.and(...items);
      return items.length === 0 ? undefined : adapter.operators.and(...items);
    }
    case "or": {
      const items = predicate.items
        .map((item) => lowerPredicate(ctx, item, alias, polarity))
        .filter((item): item is Sql => item !== undefined);
      return items.length === 0
        ? adapter.literals.false()
        : adapter.operators.or(...items);
    }
    case "not": {
      const item = lowerPredicate(ctx, predicate.item, alias, !polarity);
      return item === undefined ? undefined : adapter.operators.not(item);
    }
    case "scalar": {
      const field = fieldOf(ctx.model, predicate.column);
      const filter: Record<string, unknown> = {
        [predicate.operator]: operandValue(predicate.operand),
        ...(predicate.mode === "insensitive" ? { mode: "insensitive" } : {}),
      };
      return buildWhere(ctx, { [field]: filter }, alias);
    }
    case "structural": {
      const field = fieldOf(ctx.model, predicate.column);
      const value = literalValue(predicate.operands[0]!);
      const scalarState = ctx.model["~"].state.scalars[field]?.["~"].state;
      const column = adapter.identifiers.column(alias, predicate.column);
      if (predicate.form === "json") {
        return buildWhere(ctx, { [field]: value }, alias);
      }
      if (predicate.form === "distance") {
        return buildPointDistancePredicate(
          ctx,
          column,
          value,
          { name: field, scalarState: scalarState as never },
          polarity
        );
      }
      if (predicate.form === "within") {
        return buildGeoPointWithin(ctx, column, value);
      }
      throw new QueryEngineError(
        `pattern match: unsupported structural form '${predicate.form}'.`
      );
    }
    case "relation":
      return predicate.presence === "null" &&
        (predicate.quantifier === "is" || predicate.quantifier === "isNot")
        ? lowerPresence(ctx, predicate.extension, predicate.quantifier, alias)
        : lowerRelationLeaf(ctx, predicate, alias, polarity);
    default:
      return undefined;
  }
}

/**
 * One column equality per key member, each operand bound in the field's domain.
 *
 * Only a key the PATTERN binds to a value can address a row: a `literal` or a
 * client-side `generated` variable. A key bound by execution (`matched` — the
 * row's own matched value; `returned` — a database-assigned key) has no value
 * to spell here, and the caller passes the `WHERE` it built instead. A key that
 * is only PARTLY value-bound is refused rather than half-spelled: half a
 * compound key selects more rows than the key does.
 */
function rowKeyEqualities(
  ctx: QueryScope,
  key: readonly Variable[],
  alias: string
): Sql[] {
  const { adapter } = ctx;
  const spellable = key.filter(
    (variable) =>
      variable.binding.kind === "literal" ||
      variable.binding.kind === "generated"
  );
  if (spellable.length === 0) return [];
  if (spellable.length !== key.length) {
    throw new QueryEngineError(
      "pattern match: a row key bound partly by execution cannot address a row; pass the selector."
    );
  }
  return spellable.map((variable) => {
    const field = variable.scalar?.field ?? "";
    return adapter.operators.eq(
      adapter.identifiers.column(alias, getColumnName(ctx.model, field)),
      buildScalarSqlValue(ctx, ctx.model, field, literalValue(variable))
    );
  });
}

/** See {@link lowerPredicate}. */
export function lowerRowKey(
  ctx: QueryScope,
  key: readonly Variable[],
  alias: string
): Sql | undefined {
  const equalities = rowKeyEqualities(ctx, key, alias);
  return equalities.length === 0
    ? undefined
    : ctx.adapter.operators.and(...equalities);
}

/**
 * See {@link lowerPredicate}. FLAT: the key equalities and the predicate are
 * one conjunction (`(k1 AND k2 AND filter)`), which is the discriminator-then-
 * filters shape `buildWhereUnique` emits; nesting the key would be a
 * different statement on a compound key.
 */
export function lowerRowSelector(
  ctx: QueryScope,
  row: Row,
  alias: string
): Sql | undefined {
  const conditions = rowKeyEqualities(ctx, row.key, alias);
  const predicate = lowerPredicate(ctx, row.predicate, alias, true);
  if (predicate) conditions.push(predicate);
  return conditions.length === 0
    ? undefined
    : ctx.adapter.operators.and(...conditions);
}

function scopeAt(ctx: QueryScope, alias: string): QueryScope {
  return alias === ctx.rootAlias
    ? ctx
    : createChildScope(ctx, ctx.model, alias);
}

function lowerPresence(
  ctx: QueryScope,
  extension: Extension,
  quantifier: "is" | "isNot",
  alias: string
): Sql {
  const scope = scopeAt(ctx, alias);
  const { adapter } = scope;
  const field = fieldOfExtension(extension);
  const carrier = variantCarrier(scope, field);
  if (carrier && isVariantRowCarrier(carrier)) {
    const typeColumn = adapter.identifiers.column(
      alias,
      carrier.edge.storage.typeColumn.name
    );
    const idColumn = adapter.identifiers.column(
      alias,
      carrier.edge.storage.idColumn.name
    );
    return quantifier === "is"
      ? adapter.operators.and(
          adapter.operators.isNull(typeColumn),
          adapter.operators.isNull(idColumn)
        )
      : adapter.operators.and(
          adapter.operators.isNotNull(typeColumn),
          adapter.operators.isNotNull(idColumn)
        );
  }
  const relationRef = requireRelationRef(scope, field);
  const relation = bindRelation(scope, relationRef);
  if (relation.position === "parentHeld") {
    const columns = relation.membership.foreignFields.map((member) =>
      adapter.identifiers.column(
        scope.rootAlias,
        getColumnName(scope.model, member)
      )
    );
    if (quantifier === "is") {
      const conditions = columns.map((column) =>
        adapter.operators.isNull(column)
      );
      return conditions.length === 1
        ? conditions[0]!
        : adapter.operators.or(...conditions);
    }
    const conditions = columns.map((column) =>
      adapter.operators.isNotNull(column)
    );
    return conditions.length === 1
      ? conditions[0]!
      : adapter.operators.and(...conditions);
  }
  const traversal = buildRelationTraversal(scope, relationRef, scope.rootAlias);
  const subquery = adapter.subqueries.existsCheck(
    traversal.from(),
    adapter.operators.and(...traversal.conditions())
  );
  return quantifier === "is"
    ? adapter.operators.notExists(subquery)
    : adapter.operators.exists(subquery);
}

type RelationLeaf = Extract<Predicate, { kind: "relation" }>;

function lowerRelationLeaf(
  ctx: QueryScope,
  leaf: RelationLeaf,
  alias: string,
  polarity: boolean
): Sql | undefined {
  const scope = scopeAt(ctx, alias);
  const field = fieldOfExtension(leaf.extension);
  const carrier = variantCarrier(scope, field);
  if (carrier) {
    return isVariantRowCarrier(carrier)
      ? variantRowFilter(scope, carrier, leaf, alias, polarity)
      : variantCollectionFilter(scope, carrier, leaf, alias, polarity);
  }
  const { adapter } = scope;
  const relationRef = requireRelationRef(scope, field);
  const { quantifier } = leaf;
  const innerPolarity =
    quantifier === "none" || quantifier === "isNot" ? !polarity : polarity;
  // The traversal spends this subquery's aliases here, before the inner
  // predicate, and stays spent when `every: {}` leaves silently.
  const traversal = buildRelationTraversal(scope, relationRef, scope.rootAlias);
  const childCtx = createChildScope(
    scope,
    relationRef.targetModel,
    traversal.targetAlias
  );
  let inner = lowerPredicate(
    childCtx,
    leaf.inner,
    traversal.targetAlias,
    innerPolarity
  );
  if (quantifier === "every") {
    if (!inner) return undefined;
    inner = adapter.operators.not(inner);
  }
  const conditions: Sql[] = [...traversal.conditions()];
  if (inner) conditions.push(inner);
  const subquery = adapter.subqueries.existsCheck(
    traversal.from(),
    adapter.operators.and(...conditions)
  );
  return adapter.filters[quantifier](subquery);
}

/** polymorphic-read-builder.ts `buildPolymorphicFilterSql` (non-null forms), one recursion. */
function variantRowFilter(
  scope: QueryScope,
  relation: VariantRowCarrierSlot,
  leaf: RelationLeaf,
  alias: string,
  polarity: boolean
): Sql {
  const { adapter } = scope;
  const typeColumn = adapter.identifiers.column(
    alias,
    relation.edge.storage.typeColumn.name
  );
  const idColumn = adapter.identifiers.column(
    alias,
    relation.edge.storage.idColumn.name
  );
  const { variant } = leaf.extension;
  const edge = selectVariantRow(relation, String(variant));
  const discriminator = adapter.operators.exactTextEq(
    typeColumn,
    adapter.literals.value(edge.member.entry.storedValue)
  );
  if (!leaf.inner) return discriminator;
  const targetAlias = scope.nextAlias();
  const targetScope = createChildScope(
    scope,
    edge.member.targetModel,
    targetAlias
  );
  const targetColumn = adapter.identifiers.column(
    targetAlias,
    getColumnName(edge.member.targetModel, edge.member.referencedField)
  );
  const correlation = adapter.operators.eq(targetColumn, idColumn);
  const nestedWhere = lowerPredicate(
    targetScope,
    leaf.inner,
    targetAlias,
    leaf.quantifier === "is" ? polarity : !polarity
  );
  const predicate = nestedWhere
    ? adapter.operators.and(correlation, nestedWhere)
    : correlation;
  const existsQuery = adapter.subqueries.existsCheck(
    adapter.identifiers.table(
      getTableName(edge.member.targetModel),
      targetAlias
    ),
    predicate
  );
  return adapter.operators.and(
    discriminator,
    leaf.quantifier === "is"
      ? adapter.operators.exists(existsQuery)
      : adapter.operators.notExists(existsQuery)
  );
}

/** polymorphic-collection-filter-builder.ts, one quantifier per leaf, one recursion. */
function variantCollectionFilter(
  scope: QueryScope,
  relation: VariantJunctionCarrierSlot,
  leaf: RelationLeaf,
  alias: string,
  polarity: boolean
): Sql {
  const { adapter } = scope;
  const field = fieldOfExtension(leaf.extension);
  const arms = memberArms(scope, relation, alias);
  const { variant } = leaf.extension;
  const selected = selectArm(arms, String(variant), field);
  const targetPredicate = (arm: MemberArm, innerPolarity: boolean) => {
    if (!leaf.inner) return undefined;
    const childCtx = createChildScope(
      scope,
      arm.targetModel,
      arm.traversal.targetAlias
    );
    return lowerPredicate(
      childCtx,
      leaf.inner,
      arm.traversal.targetAlias,
      innerPolarity
    );
  };

  if (leaf.quantifier === "every") {
    const conditions: Sql[] = [];
    const predicate = targetPredicate(selected, polarity);
    if (predicate) {
      const [correlationCondition, joinCondition] =
        selected.traversal.conditions();
      const violation = adapter.operators.or(
        buildPolymorphicMemberOrphanProbe(
          scope,
          selected.membership,
          selected.traversal.targetAlias
        ),
        adapter.operators.not(predicate)
      );
      conditions.push(
        adapter.filters.every(
          adapter.subqueries.existsCheck(
            buildPolymorphicMemberOuterFrom(
              scope,
              selected.membership,
              joinCondition,
              selected.traversal.junctionAlias,
              selected.traversal.targetAlias
            ),
            adapter.operators.and(correlationCondition, violation)
          )
        )
      );
    }
    for (const arm of arms) {
      if (arm === selected) continue;
      const [correlationCondition] = arm.traversal.conditions();
      conditions.push(
        adapter.filters.every(
          adapter.subqueries.existsCheck(
            adapter.identifiers.table(
              arm.membership.table,
              arm.traversal.junctionAlias
            ),
            correlationCondition
          )
        )
      );
    }
    return adapter.operators.and(...conditions);
  }

  const quantifier = leaf.quantifier === "some" ? "some" : "none";
  const conditions: Sql[] = [...selected.traversal.conditions()];
  const predicate = targetPredicate(
    selected,
    quantifier === "some" ? polarity : !polarity
  );
  if (predicate) conditions.push(predicate);
  const subquery = adapter.subqueries.existsCheck(
    selected.traversal.from(),
    adapter.operators.and(...conditions)
  );
  return quantifier === "some"
    ? adapter.filters.some(subquery)
    : adapter.filters.none(subquery);
}

export function scopeOn(ctx: QueryScope, model: Model<any>): QueryScope {
  return ctx.model === model
    ? ctx
    : createChildScope(ctx, model, ctx.rootAlias);
}
// ---------------------------------------------------------------------------
// The public surface (the one a legacy caller will use unchanged, P2)
// ---------------------------------------------------------------------------

export interface ProjectionSelectOptions {
  /** A JSON object expression rather than comma-separated aliased columns. */
  readonly asJson?: boolean;
}

/**
 * A projection as a SELECT list, at `alias` — the twin of `buildSelect`, with a
 * `Projection` where that one takes `select` / `include`. An empty alias emits
 * bare columns, which is what a `RETURNING` list needs.
 *
 * Relation projections are lowered as correlated subqueries (never lateral
 * joins), so the result is safe in any expression position.
 */
export function buildProjectionSelect(
  ctx: QueryScope,
  projection: Projection,
  alias: string,
  options: ProjectionSelectOptions = {}
): Sql {
  const { pairs } = selectPairs(ctx, projection, alias, "subquery");
  return selectionSql(ctx, pairs, options.asJson === true);
}

/**
 * The same list, plus the column aliases DISTINCT emulation needs and the
 * lateral joins the caller must add to its FROM — the twin of
 * `buildSelectWithAliases`.
 */
export function buildProjectionSelectWithAliases(
  ctx: QueryScope,
  projection: Projection,
  alias: string,
  options: ProjectionSelectOptions = {}
): Selection {
  const { pairs, lateralJoins } = selectPairs(ctx, projection, alias, "auto");
  return {
    sql: selectionSql(ctx, pairs, options.asJson === true),
    aliases: pairs.map(([name]) => name),
    lateralJoins,
  };
}
