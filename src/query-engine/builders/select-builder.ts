/**
 * Select Builder
 *
 * Builds SELECT columns from select/include inputs.
 * Handles scalar fields and delegates relations to include-builder.
 */

import { type Sql, sql } from "@sql";
import { isRecord } from "@validation/value-guards";
import {
  createChildScope,
  getColumnName,
  getDefaultScalarFieldNames,
  getScalarFieldNames,
  isRelation,
  lookupRelation,
  variantCarrier,
} from "../context";
import {
  DISTANCE_RESULT_KEY,
  EMPTY_ROW_RESULT_KEY,
  RELATION_COUNTS_RESULT_KEY,
} from "../result-aliases";
import {
  isVariantRowCarrier,
  QueryEngineError,
  type QueryScope,
  type RelationRef,
  type VariantCarrierSlot,
} from "../types";
import { buildDistanceExpression } from "./distance-builder";
import {
  type BuildIncludeOptions,
  type BuildNestedSelection,
  buildLateralInclude,
  buildSubqueryInclude,
  type IncludeResult,
  type IncludeStrategy,
} from "./include-builder";
import { buildPolymorphicCollectionRead } from "./polymorphic-collection-read-builder";
import { buildPolymorphicRead } from "./polymorphic-read-builder";
import {
  buildPolymorphicRelationCount,
  buildRelationCount,
} from "./relation-count-builder";
import { projectScalarForTransport } from "./scalar-transport";

/**
 * Options for buildSelect
 */
export interface BuildSelectOptions {
  /**
   * If true, returns a JSON object expression.
   * If false (default), returns comma-separated aliased columns.
   */
  asJson?: boolean;
}

/**
 * Result of buildSelectWithAliases
 */
export interface SelectResult {
  sql: Sql;
  aliases: string[];
  /** Lateral join clauses to add to the query (for databases supporting LATERAL) */
  lateralJoins: Sql[];
}

/**
 * Internal result from buildSelectPairs
 */
interface SelectPairsResult {
  pairs: [string, Sql][];
  lateralJoins: Sql[];
}

const buildSubquerySelection: BuildNestedSelection = (ctx, select, include) => {
  const { pairs } = buildSelectPairs(
    ctx,
    select,
    include,
    ctx.rootAlias,
    "subquery"
  );
  return {
    sql: buildSelectionSql(ctx, pairs, true),
    lateralJoins: [],
  };
};

const buildLateralSelection: BuildNestedSelection = (ctx, select, include) => {
  const { pairs, lateralJoins } = buildSelectPairs(
    ctx,
    select,
    include,
    ctx.rootAlias,
    "auto"
  );
  return {
    sql: buildSelectionSql(ctx, pairs, true),
    lateralJoins,
  };
};

const isDistanceSelect = (value: unknown): value is { _distance: unknown } => {
  return isRecord(value) && Object.hasOwn(value, "_distance");
};

/**
 * Encode scalar columns that can't ride through JSON as-is:
 * - BigInt → TEXT: JSON numbers lose precision past Number.MAX_SAFE_INTEGER
 * - Blob → hex text: JSON can't hold binary (SQLite's json_object even
 *   throws "JSON cannot hold BLOB values")
 * Decimal pairs already carry their transport projection from pair construction
 * so flat and JSON selection use the same exact physical expression.
 * The result parser converts each back to its JS type.
 *
 * @param ctx - Query context
 * @param pairs - Scalar name and expression pairs
 * @returns Pairs with affected scalar columns wrapped
 */
function castNumericPairsForJson(
  ctx: QueryScope,
  pairs: [string, Sql][]
): [string, Sql][] {
  const scalars = ctx.model["~"].state.scalars;

  return pairs.map(([fieldName, expr]) => {
    const scalar = scalars[fieldName];
    if (scalar) {
      const scalarType = scalar["~"].state.type;
      if (scalarType === "bigint") {
        // Cast BigInt to TEXT to preserve precision in JSON.
        return [fieldName, ctx.adapter.expressions.cast(expr, "text")];
      }
      if (scalarType === "blob") {
        return [fieldName, ctx.adapter.expressions.blobToHex(expr)];
      }
    }
    return [fieldName, expr];
  });
}

function buildSelectionSql(
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

/** Build a relation projection while preserving the public advanced API. */
export function buildInclude(
  ctx: QueryScope,
  relationRef: RelationRef,
  includeValue: Record<string, unknown>,
  parentAlias: string,
  options: BuildIncludeOptions = {}
): IncludeResult {
  const parentScope =
    parentAlias === ctx.rootAlias
      ? ctx
      : createChildScope(ctx, ctx.model, parentAlias);
  if (parentAlias === "" || options.strategy === "subquery") {
    return buildSubqueryInclude(
      buildSubquerySelection,
      parentScope,
      relationRef,
      includeValue
    );
  }
  if (parentScope.adapter.capabilities.supportsLateralJoins) {
    return buildLateralInclude(
      buildLateralSelection,
      parentScope,
      relationRef,
      includeValue
    );
  }
  return buildSubqueryInclude(
    buildSubquerySelection,
    parentScope,
    relationRef,
    includeValue
  );
}

/**
 * Build SELECT columns from select/include inputs.
 *
 * @param ctx - Query context
 * @param select - Select input (fields to include)
 * @param include - Include input (relations to include)
 * @param alias - Current table alias
 * @param options - Build options
 * @returns SQL for SELECT columns (comma-separated or JSON object)
 */
export function buildSelect(
  ctx: QueryScope,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  options: BuildSelectOptions = {}
): Sql {
  // Build field/expression pairs in expression-only mode:
  // includes must be scalar subqueries so this can be embedded anywhere (e.g. RETURNING).
  const { pairs } = buildSelectPairs(ctx, select, include, alias, "subquery");

  return buildSelectionSql(ctx, pairs, options.asJson === true);
}

/**
 * Internal: Build pairs of [fieldName, expression] for select
 * Also collects lateral join clauses for databases that support them.
 */
function buildSelectPairs(
  ctx: QueryScope,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  includeStrategy: IncludeStrategy
): SelectPairsResult {
  const pairs: [string, Sql][] = [];
  const relationCountPairs: [string, Sql][] = [];
  const lateralJoins: Sql[] = [];
  const scalarFields = getScalarFieldNames(ctx.model);

  if (select) {
    // Select specific scalar fields
    const scalars = ctx.model["~"].state.scalars;
    let hasDistanceSelect = false;
    let hasDistanceOutputField = false;
    for (const fieldName of scalarFields) {
      if (select[fieldName] === true) {
        if (fieldName === "_distance") hasDistanceOutputField = true;
        const scalar = scalars[fieldName];
        const columnName = getColumnName(ctx.model, fieldName);
        const column = ctx.adapter.identifiers.column(alias, columnName);
        const scalarType = scalar?.["~"].state.type;
        pairs.push([
          fieldName,
          scalarType === "decimal" || scalarType === "point"
            ? projectScalarForTransport(ctx.adapter, scalar, column)
            : column,
        ]);
        continue;
      }

      const value = select[fieldName];
      if (isDistanceSelect(value)) {
        if (hasDistanceSelect) {
          throw new QueryEngineError(
            "Distance select supports only one _distance field per select."
          );
        }
        hasDistanceSelect = true;
        const columnName = getColumnName(ctx.model, fieldName);
        const column = ctx.adapter.identifiers.column(alias, columnName);
        pairs.push([
          DISTANCE_RESULT_KEY,
          buildDistanceExpression(
            ctx,
            column,
            value._distance,
            {
              name: fieldName,
              scalarState: scalars[fieldName]?.["~"].state,
            },
            "select"
          ),
        ]);
      }
    }
    // Handle relations in select (nested select/include)
    for (const [key, value] of Object.entries(select)) {
      if (value === undefined || value === false) {
        continue;
      }

      const relationRef = lookupRelation(ctx, key);
      const variantRelation = variantCarrier(ctx, key);
      if (isRelation(ctx.model, key) && !variantRelation) {
        if (relationRef && typeof value === "object" && value !== null) {
          const includeResult = buildInclude(
            ctx,
            relationRef,
            value as Record<string, unknown>,
            alias,
            { strategy: includeStrategy }
          );
          pairs.push([key, includeResult.column]);
          if (key === "_distance") hasDistanceOutputField = true;
          if (includeResult.lateralJoin) {
            lateralJoins.push(includeResult.lateralJoin);
          }
        }
        continue;
      }

      if (variantRelation) {
        pairs.push([
          key,
          buildPolymorphicProjection(ctx, variantRelation, value, alias),
        ]);
      }
    }
    if (hasDistanceSelect && hasDistanceOutputField) {
      throw new QueryEngineError(
        "A distance result cannot be selected together with a model field named '_distance'."
      );
    }
  } else {
    // No select specified - select all scalar fields
    const scalars = ctx.model["~"].state.scalars;
    for (const fieldName of getDefaultScalarFieldNames(ctx.model)) {
      const scalar = scalars[fieldName];
      const columnName = getColumnName(ctx.model, fieldName);
      const column = ctx.adapter.identifiers.column(alias, columnName);
      const scalarType = scalar?.["~"].state.type;
      pairs.push([
        fieldName,
        scalarType === "decimal" || scalarType === "point"
          ? projectScalarForTransport(ctx.adapter, scalar, column)
          : column,
      ]);
    }
  }

  // Handle _count in select
  const selectCount =
    select && Object.hasOwn(select, "_count") ? select._count : undefined;
  if (isRecord(selectCount)) {
    const countSelect = Object.hasOwn(selectCount, "select")
      ? selectCount.select
      : undefined;
    if (isRecord(countSelect)) {
      const countPairs = buildCountPairs(ctx, countSelect, alias);
      relationCountPairs.push(...countPairs);
    }
  }

  // Handle include (adds relations on top of scalars)
  if (include) {
    const includeCount = Object.hasOwn(include, "_count")
      ? include._count
      : undefined;
    const includeCountSelect =
      isRecord(includeCount) && Object.hasOwn(includeCount, "select")
        ? includeCount.select
        : undefined;
    if (
      getDefaultScalarFieldNames(ctx.model).includes("_count") &&
      isRecord(includeCountSelect) &&
      Object.values(includeCountSelect).some(
        (selected) => selected !== false && selected !== undefined
      )
    ) {
      throw new QueryEngineError(
        "Relation counts cannot be selected together with a model field named '_count'."
      );
    }
    for (const [key, value] of Object.entries(include)) {
      if (value === undefined || value === false) {
        continue;
      }

      // Handle _count in include
      if (key === "_count") {
        const countSelect =
          isRecord(value) && Object.hasOwn(value, "select")
            ? value.select
            : undefined;
        if (isRecord(countSelect)) {
          const countPairs = buildCountPairs(ctx, countSelect, alias);
          relationCountPairs.push(...countPairs);
        }
        continue;
      }

      const relationRef = lookupRelation(ctx, key);
      const variantRelation = variantCarrier(ctx, key);
      if (isRelation(ctx.model, key) && !variantRelation) {
        if (relationRef) {
          const includeValue =
            value === true ? {} : (value as Record<string, unknown>);
          const includeResult = buildInclude(
            ctx,
            relationRef,
            includeValue,
            alias,
            { strategy: includeStrategy }
          );
          pairs.push([key, includeResult.column]);
          if (includeResult.lateralJoin) {
            lateralJoins.push(includeResult.lateralJoin);
          }
        }
        continue;
      }

      if (variantRelation) {
        pairs.push([
          key,
          buildPolymorphicProjection(ctx, variantRelation, value, alias),
        ]);
      }
    }
  }

  if (relationCountPairs.length > 0) {
    pairs.push([
      RELATION_COUNTS_RESULT_KEY,
      ctx.adapter.json.objectFromColumns(relationCountPairs),
    ]);
  }

  if (pairs.length === 0 && select === undefined) {
    pairs.push([
      EMPTY_ROW_RESULT_KEY,
      ctx.adapter.expressions.cast(ctx.adapter.literals.value(1), "integer"),
    ]);
  }

  // Prisma parity: an empty or all-false select is an error, not "select everything"
  if (pairs.length === 0) {
    throw new QueryEngineError(
      `The 'select' statement for model '${ctx.model["~"].state.name}' needs at least one truthy value.`
    );
  }

  return { pairs, lateralJoins };
}

/**
 * Dispatch one polymorphic projection on its STORED descriptor.
 *
 * The two carriers are different documents built by different owners — the
 * row-held tagged CASE over the private `(type, id)` pair, and the collection's
 * per-arm document over the member junctions — so the split is here, at the one
 * place a projection becomes SQL, rather than inside either owner.
 */
function buildPolymorphicProjection(
  ctx: QueryScope,
  relation: VariantCarrierSlot,
  value: unknown,
  alias: string
): Sql {
  return isVariantRowCarrier(relation)
    ? buildPolymorphicRead(buildSubquerySelection, ctx, relation, value, alias)
    : buildPolymorphicCollectionRead(
        buildSubquerySelection,
        ctx,
        relation,
        value,
        alias
      );
}

/**
 * Build SELECT columns and return both SQL and column aliases.
 * Useful when the adapter needs to know column names (e.g., DISTINCT simulation).
 *
 * @param ctx - Query context
 * @param select - Select input (fields to include)
 * @param include - Include input (relations to include)
 * @param alias - Current table alias
 * @param options - Build options
 * @returns Object with SQL, column aliases, and lateral joins
 */
export function buildSelectWithAliases(
  ctx: QueryScope,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  options: BuildSelectOptions = {}
): SelectResult {
  // Build field/expression pairs
  const { pairs, lateralJoins } = buildSelectPairs(
    ctx,
    select,
    include,
    alias,
    "auto"
  );

  // Extract aliases
  const aliases = pairs.map(([name]) => name);

  // Build SQL
  return {
    sql: buildSelectionSql(ctx, pairs, options.asJson === true),
    aliases,
    lateralJoins,
  };
}

/**
 * Build count pairs for _count aggregation
 *
 * @param ctx - Query context
 * @param countSelect - Object mapping relation names to true or { where: ... }
 * @param parentAlias - Parent table alias
 * @returns Array of [fieldName, countExpression] pairs
 */
function buildCountPairs(
  ctx: QueryScope,
  countSelect: Record<string, unknown>,
  parentAlias: string
): [string, Sql][] {
  const pairs: [string, Sql][] = [];

  for (const [relationName, config] of Object.entries(countSelect)) {
    if (config === undefined || config === false) {
      continue;
    }

    const relationRef = lookupRelation(ctx, relationName);
    if (relationRef) {
      pairs.push([
        relationName,
        buildRelationCount(ctx, relationRef, config, parentAlias),
      ]);
      continue;
    }

    // A polymorphic COLLECTION joins the ordinary count surface (plan §7.4).
    // A row-held polymorphic slot does not — it has no collection to count —
    // and still leaves silently, exactly as an unknown name always has.
    const polymorphic = variantCarrier(ctx, relationName);
    if (!polymorphic || isVariantRowCarrier(polymorphic)) {
      continue;
    }
    pairs.push([
      relationName,
      buildPolymorphicRelationCount(ctx, polymorphic, config, parentAlias),
    ]);
  }

  return pairs;
}
