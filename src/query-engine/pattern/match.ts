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
import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  buildAggregateColumn,
  buildCountAggregate,
} from "../builders/aggregate-utils";
import { decimalDescriptorOf } from "../builders/decimal-field";
import { buildDistinctColumns } from "../builders/distinct-builder";
import {
  buildProjectionSelect,
  buildProjectionSelectWithAliases,
  cursorAsArgs,
  literalValue,
  lowerOrder,
  lowerPredicate,
  lowerProjection,
  lowerRowSelector,
  orderTermsAsArgs,
  projectionOf,
  rootRow,
  scopeOn,
} from "../builders/projection-select";
import { projectScalarForTransport } from "../builders/scalar-transport";
import { buildSingleOrder } from "../builders/sort-order-builder";
import {
  createQueryScope,
  getColumnName,
  getScalarFieldNames,
  getTableName,
} from "../context";
import { buildNormalizedOrderBy } from "../operations/cursor-order";
import { buildFindPagination } from "../operations/find-pagination";
import { buildHaving } from "../operations/groupby-having";
import { buildProjectionMutationFold } from "../operations/mutation-projection-fold";
import { QueryEngineError, type QueryScope, type ScopeSource } from "../types";
import type { OrderTerm, Pattern, Predicate, Row } from "./pattern";

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

export {
  keyAsWhereUnique,
  lowerPredicate,
  lowerRowKey,
  lowerRowSelector,
} from "../builders/projection-select";

// ---------------------------------------------------------------------------
// Root statements
// ---------------------------------------------------------------------------

function matchUnique(ctx: QueryScope, pattern: Pattern, root: Row): Sql {
  const { adapter, rootAlias } = ctx;
  const selection = lowerProjection(
    ctx,
    projectionOf(pattern),
    rootAlias,
    "auto"
  );
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

  const selection = lowerProjection(
    ctx,
    projectionOf(pattern),
    rootAlias,
    "auto"
  );
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
// The write's terminal projection (§8: a write answers with a read of the
// asserted rows)
// ---------------------------------------------------------------------------

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
 *   `buildUpdateManyAndReturn` share, over the one projection emitter. A relation
 *   projection cannot ride a `RETURNING` list (no alias to correlate against):
 *   the caller picks `fold` for that, exactly as today.
 * - **`fold`** — `WITH "__viborm_mutation" AS (<mutation> RETURNING <every
 *   column>), <siblings> SELECT <projection> FROM "__viborm_mutation" AS
 *   <alias>`, through `buildProjectionMutationFold`, which owns the CTE names
 *   and the all-columns RETURNING. Legality (a data-modifying `WITH`, and
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
  const projection = projectionOf(request.pattern);

  if (request.form === "returning") {
    const mutation = requireMutation(request);
    // No alias: an INSERT/UPDATE has no FROM to correlate against.
    const returning = adapter.mutations.returning(
      buildProjectionSelect(scope, projection, "")
    );
    return returning.strings.join("").trim() === ""
      ? mutation
      : sql`${mutation} ${returning}`;
  }

  if (request.form === "fold") {
    return buildProjectionMutationFold(scope, {
      mutation: requireMutation(request),
      ...(request.siblings ? { siblings: request.siblings } : {}),
      projection,
    });
  }

  const selection = buildProjectionSelectWithAliases(
    scope,
    projection,
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
    columns: selection.sql,
    from: adapter.identifiers.table(getTableName(scope.model), rootAlias),
  };
  if (selection.lateralJoins.length > 0) parts.joins = selection.lateralJoins;
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
