/**
 * Select Builder
 *
 * Builds SELECT columns from select/include inputs.
 * Handles scalar fields and delegates relations to include-builder.
 */

import { type Sql, sql } from "@sql";
import {
  getColumnName,
  getRelationInfo,
  getScalarFieldNames,
  isRelation,
} from "../context";
import { type QueryContext, QueryEngineError } from "../types";
import { buildInclude, type IncludeStrategy } from "./include-builder";
import { buildRelationCount } from "./relation-count-builder";

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
  ctx: QueryContext,
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
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  options: BuildSelectOptions = {}
): Sql {
  // Build field/expression pairs in expression-only mode:
  // includes must be scalar subqueries so this can be embedded anywhere (e.g. RETURNING).
  const { pairs } = buildSelectPairs(ctx, select, include, alias, "subquery");

  // Return JSON object if requested
  if (options.asJson) {
    // Cast BigInt scalar columns to TEXT to preserve precision in JSON serialization
    const jsonPairs = castNumericPairsForJson(ctx, pairs);
    return ctx.adapter.json.objectFromColumns(jsonPairs);
  }

  // Convert pairs to aliased columns
  const columns = pairs.map(([name, expr]) =>
    ctx.adapter.identifiers.aliased(expr, name)
  );

  return sql.join(columns, ", ");
}

/**
 * Internal: Build pairs of [fieldName, expression] for select
 * Also collects lateral join clauses for databases that support them.
 */
function buildSelectPairs(
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  includeStrategy: IncludeStrategy
): SelectPairsResult {
  const pairs: [string, Sql][] = [];
  const lateralJoins: Sql[] = [];
  const scalarFields = getScalarFieldNames(ctx.model);

  if (select) {
    // Select specific scalar fields
    for (const fieldName of scalarFields) {
      if (select[fieldName] === true) {
        const columnName = getColumnName(ctx.model, fieldName);
        pairs.push([
          fieldName,
          ctx.adapter.identifiers.column(alias, columnName),
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
          if (includeResult.lateralJoin) {
            lateralJoins.push(includeResult.lateralJoin);
          }
        }
      }
    }
  } else {
    // No select specified - select all scalar fields
    for (const fieldName of scalarFields) {
      const columnName = getColumnName(ctx.model, fieldName);
      pairs.push([
        fieldName,
        ctx.adapter.identifiers.column(alias, columnName),
      ]);
    }
  }

  // Handle _count in select
  if (select && "_count" in select && select._count) {
    const countInput = select._count as { select: Record<string, unknown> };
    if (countInput.select) {
      const countPairs = buildCountPairs(ctx, countInput.select, alias);
      pairs.push(...countPairs);
    }
  }

  // Handle include (adds relations on top of scalars)
  if (include) {
    for (const [key, value] of Object.entries(include)) {
      if (value === undefined || value === false) {
        continue;
      }

      // Handle _count in include
      if (key === "_count") {
        const countInput = value as { select: Record<string, unknown> };
        if (countInput.select) {
          const countPairs = buildCountPairs(ctx, countInput.select, alias);
          pairs.push(...countPairs);
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
  ctx: QueryContext,
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
  let sqlResult: Sql;
  if (options.asJson) {
    // Cast BigInt scalar columns to TEXT to preserve precision in JSON serialization
    const jsonPairs = castNumericPairsForJson(ctx, pairs);
    sqlResult = ctx.adapter.json.objectFromColumns(jsonPairs);
  } else {
    const columns = pairs.map(([name, expr]) =>
      ctx.adapter.identifiers.aliased(expr, name)
    );
    sqlResult = sql.join(columns, ", ");
  }

  return { sql: sqlResult, aliases, lateralJoins };
}

/**
 * Get all scalar field columns for a simple select all
 */
export function buildSelectAll(ctx: QueryContext, alias: string): Sql {
  const scalarFields = getScalarFieldNames(ctx.model);
  const columns = scalarFields.map((fieldName) => {
    const columnName = getColumnName(ctx.model, fieldName);
    return ctx.adapter.identifiers.column(alias, columnName);
  });
  return sql.join(columns, ", ");
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
  ctx: QueryContext,
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
    pairs.push([`_count_${relationName}`, countSql]);
  }

  return pairs;
}
