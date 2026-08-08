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
  getRelationInfo,
  getScalarFieldNames,
  isRelation,
} from "../context";
import {
  EMPTY_ROW_RESULT_KEY,
  RELATION_COUNTS_RESULT_KEY,
  VECTOR_DISTANCE_RESULT_KEY,
} from "../result-aliases";
import { QueryEngineError, type QueryScope, type RelationInfo } from "../types";
import {
  type BuildIncludeOptions,
  type BuildNestedSelection,
  buildLateralInclude,
  buildSubqueryInclude,
  type IncludeResult,
  type IncludeStrategy,
} from "./include-builder";
import { buildRelationCount } from "./relation-count-builder";
import { buildVectorDistanceExpression } from "./vector-distance-builder";

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

const isVectorDistanceSelect = (
  value: unknown
): value is { _distance: unknown } => {
  return isRecord(value) && Object.hasOwn(value, "_distance");
};

/**
 * Encode scalar columns that can't ride through JSON as-is:
 * - BigInt/Decimal → TEXT: JSON numbers lose precision past
 *   Number.MAX_SAFE_INTEGER / high-precision decimals
 * - Blob → hex text: JSON can't hold binary (SQLite's json_object even
 *   throws "JSON cannot hold BLOB values")
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
      if (scalarType === "bigint" || scalarType === "decimal") {
        // Cast BigInt/Decimal to TEXT to preserve precision in JSON
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
  relationInfo: RelationInfo,
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
      relationInfo,
      includeValue
    );
  }
  if (parentScope.adapter.capabilities.supportsLateralJoins) {
    return buildLateralInclude(
      buildLateralSelection,
      parentScope,
      relationInfo,
      includeValue
    );
  }
  return buildSubqueryInclude(
    buildSubquerySelection,
    parentScope,
    relationInfo,
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
        const columnName = getColumnName(ctx.model, fieldName);
        pairs.push([
          fieldName,
          ctx.adapter.identifiers.column(alias, columnName),
        ]);
        continue;
      }

      const value = select[fieldName];
      if (isVectorDistanceSelect(value)) {
        if (hasDistanceSelect) {
          throw new QueryEngineError(
            "Vector distance select supports only one _distance field per select."
          );
        }
        hasDistanceSelect = true;
        const columnName = getColumnName(ctx.model, fieldName);
        const column = ctx.adapter.identifiers.column(alias, columnName);
        pairs.push([
          VECTOR_DISTANCE_RESULT_KEY,
          buildVectorDistanceExpression(
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

      if (isRelation(ctx.model, key)) {
        const relationInfo = getRelationInfo(ctx, key);
        if (relationInfo && typeof value === "object" && value !== null) {
          const includeResult = buildInclude(
            ctx,
            relationInfo,
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
      }
    }
    if (hasDistanceSelect && hasDistanceOutputField) {
      throw new QueryEngineError(
        "A vector distance result cannot be selected together with a model field named '_distance'."
      );
    }
  } else {
    // No select specified - select all scalar fields
    for (const fieldName of getDefaultScalarFieldNames(ctx.model)) {
      const columnName = getColumnName(ctx.model, fieldName);
      pairs.push([
        fieldName,
        ctx.adapter.identifiers.column(alias, columnName),
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

      if (isRelation(ctx.model, key)) {
        const relationInfo = getRelationInfo(ctx, key);
        if (relationInfo) {
          const includeValue =
            value === true ? {} : (value as Record<string, unknown>);
          const includeResult = buildInclude(
            ctx,
            relationInfo,
            includeValue,
            alias,
            { strategy: includeStrategy }
          );
          pairs.push([key, includeResult.column]);
          if (includeResult.lateralJoin) {
            lateralJoins.push(includeResult.lateralJoin);
          }
        }
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

    const relationInfo = getRelationInfo(ctx, relationName);
    if (!relationInfo) {
      continue;
    }

    const countSql = buildRelationCount(ctx, relationInfo, config, parentAlias);
    pairs.push([relationName, countSql]);
  }

  return pairs;
}
