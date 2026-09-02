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
import { buildSingleOrder } from "../builders/sort-order-builder";
import { buildScalarSqlValue } from "../builders/values-builder";
import { buildWhere } from "../builders/where-builder";
import {
  createChildScope,
  createQueryScope,
  getColumnName,
  getScalarFieldNames,
  getTableName,
  lookupRelation,
  variantCarrier,
} from "../context";
import { buildNormalizedOrderBy } from "../operations/cursor-order";
import { buildFindPagination } from "../operations/find-pagination";
import { buildHaving } from "../operations/groupby-having";
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
import type { ReadExtension } from "./construct-read";
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

const readExtension = (extension: Extension): ReadExtension => extension;

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
  const conditions: Sql[] = root.key.map((variable) => {
    const field = variable.scalar?.field ?? "";
    return adapter.operators.eq(
      adapter.identifiers.column(rootAlias, getColumnName(ctx.model, field)),
      buildScalarSqlValue(ctx, ctx.model, field, literalValue(variable))
    );
  });
  const filter = lowerPredicate(ctx, pattern, root.predicate, rootAlias, true);
  if (filter) conditions.push(filter);
  return assembleAdapterSelect(adapter, {
    columns: selection.sql,
    from,
    ...(selection.lateralJoins.length > 0
      ? { joins: selection.lateralJoins }
      : {}),
    where: adapter.operators.and(...conditions),
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

  let where = lowerPredicate(ctx, pattern, root.predicate, rootAlias, true);
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
  let where = lowerPredicate(ctx, pattern, root.predicate, rootAlias, true);
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
  const where = lowerPredicate(ctx, pattern, root.predicate, rootAlias, true);
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
    target,
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
    target,
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
    target,
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
    target,
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
    const { variant } = readExtension(extension);
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
        target,
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
      target,
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
 * Lower one predicate tree on `alias`. Scalar leaves are spelled by the filter
 * owner (`buildWhere` over one field); structural leaves by their own owners;
 * relation leaves by this module's traversal recursion.
 */
export function lowerPredicate(
  ctx: QueryScope,
  pattern: Pattern,
  predicate: Predicate | undefined,
  alias: string,
  polarity: boolean
): Sql | undefined {
  if (!predicate) return undefined;
  const { adapter } = ctx;
  switch (predicate.kind) {
    case "and": {
      const items = predicate.items
        .map((item) => lowerPredicate(ctx, pattern, item, alias, polarity))
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
        .map((item) => lowerPredicate(ctx, pattern, item, alias, polarity))
        .filter((item): item is Sql => item !== undefined);
      return items.length === 0
        ? adapter.literals.false()
        : adapter.operators.or(...items);
    }
    case "not": {
      const item = lowerPredicate(
        ctx,
        pattern,
        predicate.item,
        alias,
        !polarity
      );
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
    leaf.extension.target,
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
  const { variant } = readExtension(leaf.extension);
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
    leaf.extension.target,
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
  const { variant } = readExtension(leaf.extension);
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
      leaf.extension.target,
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
