/**
 * G — match mode (pattern-engine-ideal-state.md §9.1, §13.3 unit G).
 *
 * ONE recursion over a match-mode pattern emits the SELECT. Every extension —
 * an include, a relation filter, a `_count`, a relation-aggregate order — is
 * lowered at ONE call site above the physical traversal
 * (`buildRelationTraversal` / `buildMembershipJunctionTraversal`), and the
 * traversal's aliases are spent exactly where today's builders spend them:
 * traversal aliases, then the lateral alias, then the nested selection, then
 * the inner alias. Scalar SPELLING (a filter operator, a sort direction, a
 * pagination normalization, a transport cast) is delegated to the adapter
 * vocabulary through the same functions today's builders call, so no operator
 * is re-spelled here.
 *
 * The output is byte-identical to today's read path; the differential in
 * tests/pattern/match is the proof.
 */
import { assembleAdapterSelect } from "@adapters/adapter-internals";
import { COUNT_RESULT_KEY } from "@adapters/shared/result-parsing";
import type { Model } from "@schema/model";
import { getModelKeyCatalog } from "@schema/model";
import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  buildAggregateColumn,
  buildCountAggregate,
} from "../builders/aggregate-utils";
import { decimalDescriptorOf } from "../builders/decimal-field";
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
import {
  buildSelect,
  buildSelectWithAliases,
} from "../builders/select-builder";
import { buildSingleOrder } from "../builders/sort-order-builder";
import { buildScalarSqlValue } from "../builders/values-builder";
import { buildWhere } from "../builders/where-builder";
import {
  createChildScope,
  createQueryScope,
  getColumnName,
  getDefaultScalarFieldNames,
  getScalarFieldNames,
  getTableName,
  lookupRelation,
  variantCarrier,
} from "../context";
import { buildNormalizedOrderBy } from "../operations/cursor-order";
import { buildFindPagination } from "../operations/find-pagination";
import { buildHaving } from "../operations/groupby-having";
import { buildMutationProjectionFold } from "../operations/mutation-projection-fold";
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
  type ScopeSource,
  type VariantJunctionCarrierSlot,
  type VariantRowCarrierSlot,
} from "../types";
import type {
  Extension,
  OrderTerm,
  Pattern,
  Predicate,
  Projection,
  Row,
  Variable,
  Window,
} from "./pattern";

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/** Compile one match-mode pattern to the SELECT today's read path emits. */
export function buildMatch(pattern: Pattern, source: ScopeSource): Sql {
  const root = rootRow(pattern);
  const ctx = createQueryScope(source, root.table.model);
  switch (pattern.operation) {
    case "findUnique":
      return matchUnique(ctx, pattern, root);
    case "findFirst":
    case "findMany":
      return matchFind(ctx, pattern, root);
    case "count":
    case "exist":
      return matchCount(ctx, pattern, root);
    case "aggregate":
      return matchAggregate(ctx, pattern, root);
    case "groupBy":
      return matchGroupBy(ctx, pattern, root);
    default:
      throw new QueryEngineError(
        `pattern match: '${pattern.operation}' is not a read.`
      );
  }
}

function rootRow(pattern: Pattern): Row {
  const row = pattern.rows.find((r) => r.id === pattern.root);
  if (!row) throw new QueryEngineError("pattern match: no root row.");
  return row;
}

function projectionOf(pattern: Pattern): Projection {
  return (
    pattern.projection ?? { scalars: [], relations: [], relationCounts: [] }
  );
}

const literalValue = (variable: Variable): unknown =>
  variable.binding.kind === "literal" ? variable.binding.value : undefined;

const operandValue = (operand: Variable | readonly Variable[]): unknown =>
  Array.isArray(operand)
    ? (operand as readonly Variable[]).map(literalValue)
    : literalValue(operand as Variable);

const fieldCache = new WeakMap<Model<any>, Map<string, string>>();

/** The public field behind a physical column of one model. */
function fieldOf(model: Model<any>, column: string): string {
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

const fieldOfExtension = (extension: Extension): string =>
  extension.reference.relation.field;

function requireRelationRef(ctx: QueryScope, field: string): RelationRef {
  const ref = lookupRelation(ctx, field);
  if (!ref) {
    throw new QueryEngineError(`pattern match: unknown relation '${field}'.`);
  }
  return ref;
}

// ---------------------------------------------------------------------------
// Root statements
// ---------------------------------------------------------------------------

function matchUnique(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter, rootAlias } = ctx;
  const selection = lowerProjection(ctx, pattern, rootAlias, "auto");
  const from = adapter.identifiers.table(getTableName(ctx.model), rootAlias);
  // The flat discriminator-then-filters conjunction `buildWhereUnique` emits.
  return assembleAdapterSelect(adapter, {
    columns: selection.sql,
    from,
    ...(selection.lateralJoins.length > 0
      ? { joins: selection.lateralJoins }
      : {}),
    where: lowerRowSelector(ctx, root, rootAlias) ?? adapter.operators.and(),
    limit: sql`1`,
  });
}

function matchFind(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter, rootAlias } = ctx;
  const projection = projectionOf(pattern);
  const window = projection.window ?? { orderBy: [] };
  const limit = window.take;
  const pagination = buildFindPagination(
    ctx,
    {
      orderBy: orderTermsAsArgs(ctx.model, window),
      ...(window.cursor ? { cursor: cursorAsArgs(ctx.model, window) } : {}),
      ...(window.skip !== undefined ? { skip: window.skip } : {}),
    },
    limit,
    rootAlias
  );

  const selection = lowerProjection(ctx, pattern, rootAlias, "auto");
  const from = adapter.identifiers.table(getTableName(ctx.model), rootAlias);

  let where = lowerPredicate(ctx, root.predicate, rootAlias, true);
  if (pagination.cursorCondition) {
    where = where
      ? adapter.operators.and(where, pagination.cursorCondition)
      : pagination.cursorCondition;
  }

  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [] as Sql[],
      }
    : lowerOrder(ctx, window, rootAlias, limit !== undefined && limit < 0);

  const parts: Parameters<typeof assembleAdapterSelect>[1] = {
    columns: selection.sql,
    from,
  };
  const joins = [...selection.lateralJoins, ...orderByParts.joins];
  if (joins.length > 0) parts.joins = joins;
  const distinct = window.distinct
    ? buildDistinctColumns(ctx, [...window.distinct], rootAlias)
    : undefined;
  if (distinct) {
    parts.distinct = distinct;
    parts.distinctColumnAliases = selection.aliases;
  }
  if (where) parts.where = where;
  if (orderByParts.orderBy) parts.orderBy = orderByParts.orderBy;
  if (limit !== undefined)
    parts.limit = adapter.literals.value(Math.abs(limit));
  if (window.skip !== undefined) {
    parts.offset = adapter.literals.value(window.skip);
  }
  return assembleAdapterSelect(adapter, parts);
}

// ---------------------------------------------------------------------------
// Aggregations
// ---------------------------------------------------------------------------

/** The paged input rowset count/aggregate read from (aggregate-input.ts, one recursion). */
function aggregateInput(
  ctx: QueryScope,
  pattern: Pattern,
  root: Row,
  fieldNames: Iterable<string>
): { from: Sql; alias: string } {
  const { adapter, rootAlias } = ctx;
  const inputAlias = "aggregate_input";
  const window = projectionOf(pattern).window ?? { orderBy: [] };
  const pagination = buildFindPagination(
    ctx,
    {
      orderBy: orderTermsAsArgs(ctx.model, window),
      ...(window.cursor ? { cursor: cursorAsArgs(ctx.model, window) } : {}),
      ...(window.skip !== undefined ? { skip: window.skip } : {}),
    },
    window.take,
    rootAlias
  );
  let where = lowerPredicate(ctx, root.predicate, rootAlias, true);
  if (pagination.cursorCondition) {
    where = where
      ? adapter.operators.and(where, pagination.cursorCondition)
      : pagination.cursorCondition;
  }
  const orderByParts = pagination.normalizedOrder
    ? {
        orderBy: buildNormalizedOrderBy(ctx, pagination.normalizedOrder),
        joins: [] as Sql[],
      }
    : lowerOrder(
        ctx,
        window,
        rootAlias,
        window.take !== undefined && window.take < 0
      );

  const columns: Sql[] = [];
  for (const field of new Set(fieldNames)) {
    const column = getColumnName(ctx.model, field);
    columns.push(
      adapter.identifiers.aliased(
        adapter.identifiers.column(rootAlias, column),
        column
      )
    );
  }
  const parts: Parameters<typeof assembleAdapterSelect>[1] = {
    columns:
      columns.length === 0
        ? adapter.identifiers.aliased(adapter.raw("1"), "_row")
        : sql.join(columns, ", "),
    from: adapter.identifiers.table(getTableName(ctx.model), rootAlias),
  };
  if (orderByParts.joins.length > 0) parts.joins = orderByParts.joins;
  if (where) parts.where = where;
  if (orderByParts.orderBy) parts.orderBy = orderByParts.orderBy;
  if (window.take !== undefined) {
    parts.limit = adapter.literals.value(Math.abs(window.take));
  }
  if (window.skip !== undefined) {
    parts.offset = adapter.literals.value(window.skip);
  }
  return {
    from: adapter.subqueries.correlate(
      assembleAdapterSelect(adapter, parts),
      inputAlias
    ),
    alias: inputAlias,
  };
}

function matchCount(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter } = ctx;
  const aggregates = projectionOf(pattern).aggregates ?? [];
  const selected = aggregates.map((entry) => entry.column ?? "_all");
  const input = aggregateInput(
    ctx,
    pattern,
    root,
    selected.filter((field) => field !== "_all")
  );
  const counts: Sql[] = [];
  if (selected.includes("_all")) {
    counts.push(
      adapter.identifiers.aliased(adapter.aggregates.count(), "_all")
    );
  }
  for (const field of selected) {
    if (field === "_all") continue;
    counts.push(
      adapter.identifiers.aliased(
        adapter.aggregates.count(
          adapter.identifiers.column(
            input.alias,
            getColumnName(ctx.model, field)
          )
        ),
        field
      )
    );
  }
  return assembleAdapterSelect(adapter, {
    columns:
      counts.length === 0
        ? adapter.identifiers.aliased(
            adapter.aggregates.count(),
            COUNT_RESULT_KEY
          )
        : sql.join(counts, ", "),
    from: input.from,
  });
}

type AggregateSpecs = Record<
  "count" | "avg" | "sum" | "min" | "max",
  true | Record<string, boolean> | undefined
>;

/** The public per-aggregate specs, rebuilt from the projection's aggregate entries. */
function aggregateSpecs(pattern: Pattern): AggregateSpecs {
  const specs: AggregateSpecs = {
    count: undefined,
    avg: undefined,
    sum: undefined,
    min: undefined,
    max: undefined,
  };
  for (const entry of projectionOf(pattern).aggregates ?? []) {
    if (entry.column === undefined) {
      specs[entry.kind] = true;
      continue;
    }
    const current = specs[entry.kind];
    const spec = isRecord(current) ? current : {};
    spec[entry.column] = true;
    specs[entry.kind] = spec;
  }
  return specs;
}

function aggregateFieldNames(specs: AggregateSpecs): string[] {
  const fields = new Set<string>();
  for (const kind of ["count", "avg", "sum", "min", "max"] as const) {
    const spec = specs[kind];
    if (!isRecord(spec)) continue;
    for (const field of Object.keys(spec)) {
      if (field !== "_all") fields.add(field);
    }
  }
  return [...fields];
}

function aggregateColumns(
  ctx: QueryScope,
  specs: AggregateSpecs,
  alias: string
): Sql[] {
  const columns: Sql[] = [];
  if (specs.count) {
    const column = buildCountAggregate(ctx, specs.count, alias);
    if (column) columns.push(column);
  }
  for (const kind of ["avg", "sum", "min", "max"] as const) {
    const spec = specs[kind];
    if (!spec) continue;
    const column = buildAggregateColumn(ctx, spec, alias, kind);
    if (column) columns.push(column);
  }
  return columns;
}

function matchAggregate(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter } = ctx;
  const specs = aggregateSpecs(pattern);
  const input = aggregateInput(ctx, pattern, root, aggregateFieldNames(specs));
  const columns = aggregateColumns(ctx, specs, input.alias);
  if (columns.length === 0) {
    throw new QueryEngineError(
      "Aggregate operation requires at least one aggregate field (_count, _avg, _sum, _min, _max)"
    );
  }
  return assembleAdapterSelect(adapter, {
    columns: sql.join(columns, ", "),
    from: input.from,
  });
}

function matchGroupBy(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter, rootAlias } = ctx;
  const projection = projectionOf(pattern);
  const byFields = [...(projection.groupBy ?? [])];
  const scalarFields = getScalarFieldNames(ctx.model);
  for (const field of byFields) {
    if (!scalarFields.includes(field)) {
      throw new QueryEngineError(
        `GroupBy field '${field}' not found on model '${ctx.model["~"].state.name}'`
      );
    }
  }
  if (byFields.length === 0) {
    throw new QueryEngineError(
      "GroupBy operation requires at least one field in 'by'"
    );
  }
  const specs = aggregateSpecs(pattern);
  for (const name of ["_count", "_avg", "_sum", "_min", "_max"] as const) {
    if (!byFields.includes(name)) continue;
    const spec = specs[name.slice(1) as keyof AggregateSpecs];
    const hasOutput =
      spec === true ||
      (isRecord(spec) && Object.values(spec).some((v) => v === true));
    if (hasOutput) {
      throw new QueryEngineError(
        `GroupBy cannot return both grouped scalar '${name}' and aggregate '${name}' in one result.`
      );
    }
  }

  const columns: Sql[] = byFields.map((field) =>
    adapter.identifiers.aliased(
      projectScalarForTransport(
        adapter,
        ctx.model["~"].state.scalars[field],
        adapter.identifiers.column(rootAlias, getColumnName(ctx.model, field))
      ),
      field
    )
  );
  columns.push(...aggregateColumns(ctx, specs, rootAlias));

  const from = adapter.identifiers.table(getTableName(ctx.model), rootAlias);
  const where = lowerPredicate(ctx, root.predicate, rootAlias, true);
  const groupBy = sql.join(
    byFields.map((field) =>
      adapter.identifiers.column(rootAlias, getColumnName(ctx.model, field))
    ),
    ", "
  );
  const having = projection.having
    ? buildHaving(
        ctx,
        havingAsArgs(ctx.model, projection.having),
        rootAlias,
        byFields
      )
    : undefined;
  const window = projection.window ?? { orderBy: [] };
  const orders: Sql[] = [];
  for (const term of window.orderBy as readonly OrderTerm[]) {
    if (term.kind === "aggregate") {
      orders.push(
        buildSingleOrder(
          ctx,
          groupByAggregateExpression(
            ctx,
            term.aggregate,
            term.field,
            rootAlias
          ),
          term.direction
        )
      );
      continue;
    }
    if (term.kind === "scalar") {
      orders.push(
        buildSingleOrder(
          ctx,
          adapter.identifiers.column(rootAlias, term.column),
          term.nulls
            ? { sort: term.direction, nulls: term.nulls }
            : term.direction
        )
      );
      continue;
    }
    if (term.kind === "structural") {
      orders.push(
        buildSingleOrder(
          ctx,
          adapter.identifiers.column(rootAlias, term.column),
          literalValue(term.operand)
        )
      );
      continue;
    }
    throw new QueryEngineError(
      `GroupBy orderBy field must be included in 'by' or be an aggregate (_count, _avg, _sum, _min, _max).`
    );
  }

  const parts: Parameters<typeof assembleAdapterSelect>[1] = {
    columns: sql.join(columns, ", "),
    from,
  };
  if (where) parts.where = where;
  parts.groupBy = groupBy;
  if (having) parts.having = having;
  if (orders.length > 0) parts.orderBy = sql.join(orders, ", ");
  if (window.take !== undefined) {
    parts.limit = adapter.literals.value(window.take);
  }
  if (window.skip !== undefined) {
    parts.offset = adapter.literals.value(window.skip);
  }
  return assembleAdapterSelect(adapter, parts);
}

function groupByAggregateExpression(
  ctx: QueryScope,
  aggregate: string,
  field: string,
  alias: string
): Sql {
  const { adapter } = ctx;
  if (aggregate === "_count" && field === "_all") {
    return adapter.aggregates.count();
  }
  const column = adapter.identifiers.column(
    alias,
    getColumnName(ctx.model, field)
  );
  const decimal = decimalDescriptorOf(ctx.model, field);
  switch (aggregate) {
    case "_count":
      return adapter.aggregates.count(column);
    case "_avg":
      return decimal
        ? adapter.aggregates.decimalAvg(column, decimal)
        : adapter.aggregates.avg(column);
    case "_sum":
      return adapter.aggregates.sum(column);
    case "_min":
      return adapter.aggregates.min(column);
    case "_max":
      return adapter.aggregates.max(column);
    default:
      throw new QueryEngineError(`Unknown orderBy aggregate '${aggregate}'.`);
  }
}

/** The public HAVING object, rebuilt from the structural leaves construction kept. */
function havingAsArgs(
  model: Model<any>,
  predicate: Predicate
): Record<string, unknown> {
  const object: Record<string, unknown> = {};
  const items = predicate.kind === "and" ? predicate.items : [predicate];
  for (const item of items) {
    if (item.kind === "structural") {
      const [key, value] = item.operands;
      object[String(literalValue(key!))] = literalValue(value!);
      continue;
    }
    if (item.kind === "or") {
      object.OR = item.items.map((child) => havingAsArgs(model, child));
      continue;
    }
    if (item.kind === "and") {
      if (item.items.length > 0 && item.items.every((c) => c.kind === "not")) {
        object.NOT = item.items.map((child) =>
          havingAsArgs(model, (child as { item: Predicate }).item)
        );
        continue;
      }
      object.AND = item.items.map((child) => havingAsArgs(model, child));
      continue;
    }
    if (item.kind === "not") {
      object.NOT = [havingAsArgs(model, item.item)];
    }
  }
  return object;
}

// ---------------------------------------------------------------------------
// Window → the pagination owner's public inputs
// ---------------------------------------------------------------------------

/**
 * The order terms in the public spelling `buildFindPagination` normalizes: one
 * single-key item per term. Only scalar-ness and direction are read from it.
 */
function orderTermsAsArgs(
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
function cursorAsArgs(
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

interface Selection {
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
    pattern,
    ctx.rootAlias,
    strategy
  );
  return { sql: selectionSql(ctx, pairs, true), lateralJoins };
}

function lowerProjection(
  ctx: QueryScope,
  pattern: Pattern,
  alias: string,
  strategy: Strategy
): Selection {
  const { pairs, lateralJoins } = selectPairs(ctx, pattern, alias, strategy);
  return {
    sql: selectionSql(ctx, pairs, false),
    aliases: pairs.map(([name]) => name),
    lateralJoins,
  };
}

function selectPairs(
  ctx: QueryScope,
  pattern: Pattern,
  alias: string,
  strategy: Strategy
): { pairs: [string, Sql][]; lateralJoins: Sql[] } {
  const { adapter, model } = ctx;
  const projection = projectionOf(pattern);
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
function nestedWindow(
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

function lowerCount(
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
function lowerOrder(
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

// ---------------------------------------------------------------------------
// The write's terminal projection (§8: a write answers with a read of the
// asserted rows)
// ---------------------------------------------------------------------------

/**
 * The public projection request one K1 `Projection` states.
 *
 * K1 is the truth; this is its spelling in the vocabulary today's projection
 * builders (`buildSelect`, `buildMutationProjectionFold`) still take. It is a
 * TOTAL inverse of `construct-read`'s projection walk — scalars, the computed
 * `_distance`, relation projections with their own `where`, window and nested
 * projection, variant arms, and `_count` — and the round-trip is pinned over
 * the whole read corpus in `tests/pattern/match/write-result.core.test.ts`.
 * When those builders take a `Projection` directly, this goes away.
 */
interface ProjectionArgs {
  readonly select?: Record<string, unknown>;
  readonly include?: Record<string, unknown>;
}

const sameFields = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((field, index) => b[index] === field);

function scopeOn(ctx: QueryScope, model: Model<any>): QueryScope {
  return ctx.model === model
    ? ctx
    : createChildScope(ctx, model, ctx.rootAlias);
}

/**
 * One K1 `Predicate` as the public `where` it was built from.
 *
 * A conjunction is spelled `AND: [...]`, never merged into one object: two
 * conjuncts may constrain the SAME field (`{ label: "a", AND: [{ label: "b" }] }`),
 * and merging them would drop one and regroup the rest. The array form compiles
 * to the identical SQL as the object it came from — `operators.and` of one
 * conjunct is that conjunct — so the grouping the pattern holds survives.
 */
function predicateAsArgs(
  ctx: QueryScope,
  predicate: Predicate | undefined
): Record<string, unknown> | undefined {
  if (!predicate) return undefined;
  switch (predicate.kind) {
    case "and":
      return { AND: predicate.items.map((item) => predicateAsArgs(ctx, item)) };
    case "or":
      return { OR: predicate.items.map((item) => predicateAsArgs(ctx, item)) };
    case "not":
      return { NOT: [predicateAsArgs(ctx, predicate.item)] };
    case "scalar":
      return {
        [fieldOf(ctx.model, predicate.column)]: {
          [predicate.operator]: operandValue(predicate.operand),
          ...(predicate.mode === "insensitive" ? { mode: "insensitive" } : {}),
        },
      };
    case "structural": {
      const value = literalValue(predicate.operands[0]!);
      // A JSON filter rides whole (the leaf carries the public filter object);
      // a geo leaf is one operator of an ordinary filter object.
      return {
        [fieldOf(ctx.model, predicate.column)]:
          predicate.form === "json" ? value : { [predicate.form]: value },
      };
    }
    case "relation":
      return {
        [fieldOfExtension(predicate.extension)]: relationFilterArgs(
          ctx,
          predicate
        ),
      };
    default:
      return {};
  }
}

/** `{ some: … }` / `{ is: null }` / a tagged variant predicate, as written. */
function relationFilterArgs(
  ctx: QueryScope,
  leaf: Extract<Predicate, { kind: "relation" }>
): Record<string, unknown> {
  const { quantifier } = leaf;
  if (leaf.presence === "null") return { [quantifier]: null };
  const carrier = variantCarrier(ctx, fieldOfExtension(leaf.extension));
  const target = extensionScope(ctx, leaf.extension);
  if (!carrier) {
    return { [quantifier]: predicateAsArgs(target, leaf.inner) ?? {} };
  }
  if (isVariantRowCarrier(carrier)) {
    // A ROW carrier states its polarity in the QUANTIFIER — `is` / `isNot` —
    // and carries its predicate as written; the negation happens at lowering.
    const innerArgs = predicateAsArgs(target, leaf.inner);
    return {
      type: leaf.extension.variant,
      ...(innerArgs ? { [quantifier]: innerArgs } : {}),
    };
  }
  // A COLLECTION arm's quantifier is `some` / `every` / `none`, and an `isNot`
  // member predicate arrives already negated: that inner `not` is what says so.
  const negated = leaf.inner?.kind === "not";
  const innerArgs = predicateAsArgs(
    target,
    negated ? (leaf.inner as { item: Predicate }).item : leaf.inner
  );
  return {
    [quantifier]: {
      type: leaf.extension.variant,
      ...(innerArgs ? { [negated ? "isNot" : "is"]: innerArgs } : {}),
    },
  };
}

/** The scope of an extension's target row. */
function extensionScope(ctx: QueryScope, extension: Extension): QueryScope {
  return scopeOn(ctx, extensionRow(extension).table.model);
}

function extensionRow(extension: Extension): Row {
  const target = extension.target;
  const row = target.rows.find((candidate) => candidate.id === target.root);
  if (!row) throw new QueryEngineError("pattern match: extension has no root.");
  return row;
}

/** A nested relation's own read args: its projection, `where` and window. */
function relationAsArgs(
  ctx: QueryScope,
  extension: Extension
): Record<string, unknown> {
  const scope = extensionScope(ctx, extension);
  const where = predicateAsArgs(scope, extensionRow(extension).predicate);
  const window = projectionOf(extension.target).window;
  return {
    ...projectionAsArgs(scope, extension.target),
    ...(where ? { where } : {}),
    ...(window ? windowAsArgs(scope.model, window) : {}),
  };
}

/** A nested window as the public `orderBy` / `take` / `skip` / `cursor` / `distinct`. */
function windowAsArgs(
  model: Model<any>,
  window: Window
): Record<string, unknown> {
  const orderBy = orderTermsAsArgs(model, window);
  return {
    ...(orderBy ? { orderBy } : {}),
    ...(window.take !== undefined ? { take: window.take } : {}),
    ...(window.skip !== undefined ? { skip: window.skip } : {}),
    ...(window.cursor
      ? { cursor: keyAsWhereUnique(model, window.cursor.key) }
      : {}),
    ...(window.distinct ? { distinct: [...window.distinct] } : {}),
  };
}

/** `_count: { select: … }`, or `undefined` when nothing is counted. */
function countsAsArgs(
  ctx: QueryScope,
  projection: Projection
): Record<string, unknown> | undefined {
  if (projection.relationCounts.length === 0) return undefined;
  const select: Record<string, unknown> = {};
  for (const { field, extension } of projection.relationCounts) {
    const scope = extensionScope(ctx, extension);
    const predicate = extensionRow(extension).predicate;
    const negated = predicate?.kind === "not";
    const where = predicateAsArgs(
      scope,
      negated ? (predicate as { item: Predicate }).item : predicate
    );
    const { variant } = extension;
    if (variant !== undefined) {
      select[field] = {
        where: {
          type: variant,
          ...(where ? { [negated ? "isNot" : "is"]: where } : {}),
        },
      };
      continue;
    }
    select[field] = where ? { where } : true;
  }
  return { select };
}

/** Every relation key of one projection, variant arms folded back together. */
function relationsAsArgs(
  ctx: QueryScope,
  projection: Projection
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = projection.relations;
  for (let i = 0; i < entries.length; ) {
    const { field } = entries[i]!;
    let end = i + 1;
    while (end < entries.length && entries[end]!.field === field) end++;
    const arms = entries.slice(i, end);
    i = end;
    const carrier = variantCarrier(ctx, field);
    if (!carrier) {
      out[field] = relationAsArgs(ctx, arms[0]!.extension);
      continue;
    }
    if (isVariantRowCarrier(carrier)) {
      const byVariant: Record<string, unknown> = {};
      for (const arm of arms) {
        byVariant[String(arm.variant)] = relationAsArgs(ctx, arm.extension);
      }
      out[field] = byVariant;
      continue;
    }
    const variants: Record<string, unknown> = {};
    const only: string[] = [];
    for (const arm of arms) {
      if (arm.visible !== false) only.push(String(arm.variant));
      variants[String(arm.variant)] = relationAsArgs(ctx, arm.extension);
    }
    out[field] = {
      ...(only.length === arms.length ? {} : { only }),
      variants,
    };
  }
  return out;
}

/** One K1 `Projection` as the `select` / `include` it was built from. */
function projectionAsArgs(ctx: QueryScope, pattern: Pattern): ProjectionArgs {
  const scope = scopeOn(ctx, rootRow(pattern).table.model);
  const projection = projectionOf(pattern);
  const relations = relationsAsArgs(scope, projection);
  const counts = countsAsArgs(scope, projection);
  const distance = projection.computed?.find(
    (entry) => entry.form === "distance"
  );
  const hasRelations = Object.keys(relations).length > 0;
  // Default scalars beside relations is what an `include` projects; anything
  // else names its scalars, which is a `select`.
  const defaulted = sameFields(
    projection.scalars,
    getDefaultScalarFieldNames(scope.model)
  );
  if (defaulted && !distance) {
    if (!(hasRelations || counts)) return {};
    return { include: { ...relations, ...(counts ? { _count: counts } : {}) } };
  }
  const select: Record<string, unknown> = {};
  for (const field of projection.scalars) select[field] = true;
  if (distance) {
    select[String(literalValue(distance.operands[0]!))] = {
      _distance: literalValue(distance.operands[1]!),
    };
  }
  Object.assign(select, relations);
  if (counts) select._count = counts;
  return { select };
}

/** How the packer attaches the terminal projection to its mutation. */
export type WriteResultForm = "returning" | "fold" | "reselect";

export interface WriteResultRequest {
  /**
   * The terminal match pattern: its `projection` IS the result shape, and its
   * ROOT ROW is the asserted row (its key addresses a reselect, its
   * cardinality decides whether that read is `LIMIT 1`).
   */
  readonly pattern: Pattern;
  readonly form: WriteResultForm;
  /** The mutating statement WITHOUT a `RETURNING` clause (`returning`, `fold`). */
  readonly mutation?: Sql;
  /** Further self-contained write arms carried as unread CTE arms (`fold`). */
  readonly siblings?: readonly Sql[];
  /**
   * The reselect's `WHERE`. Defaults to the root row's key equalities and
   * predicate ({@link lowerRowSelector}); the packer overrides it when the key
   * is a value only it can spell (a generated key it captured, an
   * exact-membership pin over captured rows).
   */
  readonly selector?: Sql;
}

/**
 * THE WRITE'S TERMINAL PROJECTION — §8's "a write answers with a read of the
 * asserted rows", in the three statement forms today's engine emits, and the
 * one entry the packer (D+E) calls for all of them. Nothing here goes through
 * the public-args path: the projection comes from K1 and the selector is SQL.
 *
 * ```ts
 * matchWriteResult(ctx, { pattern, form, mutation?, siblings?, selector? }): Sql
 * ```
 *
 * `ctx` is a `QueryScope` on the asserted row's model (`createQueryScope(engine,
 * model)`); its `rootAlias` is the alias the projection is read under. The
 * forms:
 *
 * - **`returning`** — `<mutation> RETURNING <projection at no alias>`, on a
 *   driver whose `mutations.returning` emits a clause. The mutation's own rows
 *   ARE the result. These are the two lines `buildCreate` / `buildUpdate` /
 *   `buildUpdateManyAndReturn` share, called rather than copied. A relation
 *   projection cannot ride a `RETURNING` list (no alias to correlate against):
 *   the caller picks `fold` for that, exactly as today.
 * - **`fold`** — `WITH "__viborm_mutation" AS (<mutation> RETURNING <every
 *   column>), <siblings> SELECT <projection> FROM "__viborm_mutation" AS
 *   <alias>`, through today's `buildMutationProjectionFold`, which owns the CTE
 *   names and the all-columns RETURNING. Legality (a data-modifying `WITH`, and
 *   a projection that reads nothing the statement changes) stays the caller's,
 *   as it is today.
 * - **`reselect`** — `SELECT <projection> FROM <table> AS <alias> WHERE
 *   <selector> [LIMIT 1]`, the read a non-returning driver runs after its
 *   mutation. `LIMIT 1` is emitted for a root row of cardinality `one` (today's
 *   `buildFindUnique` shape, a literal), omitted for a `set` (today's
 *   `buildFind` with no limit). `insertId` and a literal key are the SAME
 *   statement — the difference is which value the key variable carries — which
 *   is why the binding is not a parameter here: pass the key on the row, or the
 *   whole `WHERE` through `selector`.
 *
 * The rows come back through {@link decodeRows} on the same pattern, so a
 * write's result is decoded by the projection that built it.
 */
export function matchWriteResult(
  ctx: QueryScope,
  request: WriteResultRequest
): Sql {
  const { adapter, rootAlias } = ctx;
  const root = rootRow(request.pattern);
  const scope = scopeOn(ctx, root.table.model);
  const args = projectionAsArgs(scope, request.pattern);

  if (request.form === "returning") {
    const mutation = requireMutation(request);
    const returning = adapter.mutations.returning(
      buildSelect(scope, args.select, args.include, "")
    );
    return returning.strings.join("").trim() === ""
      ? mutation
      : sql`${mutation} ${returning}`;
  }

  if (request.form === "fold") {
    return buildMutationProjectionFold(scope, {
      mutation: requireMutation(request),
      ...(request.siblings ? { siblings: request.siblings } : {}),
      ...(args.select ? { select: args.select } : {}),
      ...(args.include ? { include: args.include } : {}),
    });
  }

  const projection = buildSelectWithAliases(
    scope,
    args.select,
    args.include,
    rootAlias
  );
  const where = request.selector ?? lowerRowSelector(scope, root, rootAlias);
  if (!where) {
    // A read with no WHERE answers with the whole table: refuse rather than
    // widen. The row is addressed by a key only execution binds.
    throw new QueryEngineError(
      "pattern match: the reselect needs a selector; this row is addressed by a key the pattern does not spell."
    );
  }
  const parts: Parameters<typeof assembleAdapterSelect>[1] = {
    columns: projection.sql,
    from: adapter.identifiers.table(getTableName(scope.model), rootAlias),
  };
  if (projection.lateralJoins.length > 0) parts.joins = projection.lateralJoins;
  if (where) parts.where = where;
  // A literal `1`, not a bound parameter: the unique terminal read's own
  // spelling. A `set` row carries no limit — its selector is the whole answer.
  if (root.cardinality === "one") parts.limit = sql`1`;
  return assembleAdapterSelect(adapter, parts);
}

function requireMutation(request: WriteResultRequest): Sql {
  if (!request.mutation) {
    throw new QueryEngineError(
      `pattern match: the '${request.form}' write result needs its mutation statement.`
    );
  }
  return request.mutation;
}
