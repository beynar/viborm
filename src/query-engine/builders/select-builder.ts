/**
 * Select Builder
 *
 * Builds SELECT columns from select/include inputs.
 * Handles scalar fields and delegates relations to include-builder.
 */

import { type Sql, sql } from "@sql";
import { parse } from "@validation";
import {
  createChildContext,
  getColumnName,
  getRelationInfo,
  getScalarFieldNames,
  getTableName,
  isRelation,
} from "../context";
import type { QueryContext, RelationInfo } from "../types";
import { buildCorrelation } from "./correlation-utils";
import { buildInclude, type IncludeStrategy } from "./include-builder";
import {
  buildManyToManyJoinParts,
  getManyToManyJoinInfo,
} from "./many-to-many-utils";
import { buildWhere } from "./where-builder";

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
    return ctx.adapter.json.objectFromColumns(pairs);
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

  // Fallback to all scalars if empty
  if (pairs.length === 0) {
    for (const fieldName of scalarFields) {
      const columnName = getColumnName(ctx.model, fieldName);
      pairs.push([
        fieldName,
        ctx.adapter.identifiers.column(alias, columnName),
      ]);
    }
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
    sqlResult = ctx.adapter.json.objectFromColumns(pairs);
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

/**
 * Build a COUNT subquery for a relation
 *
 * @param ctx - Query context
 * @param relationInfo - Relation metadata
 * @param config - true or { where: ... }
 * @param parentAlias - Parent table alias
 * @returns SQL for COUNT subquery
 */
function buildRelationCount(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  config: unknown,
  parentAlias: string
): Sql {
  const { adapter } = ctx;

  // Handle manyToMany specially
  if (relationInfo.type === "manyToMany") {
    return buildManyToManyCount(ctx, relationInfo, config, parentAlias);
  }

  const targetAlias = ctx.nextAlias();
  const targetTableName = getTableName(relationInfo.targetModel);
  const targetTable = adapter.identifiers.table(targetTableName, targetAlias);

  // Build correlation
  const correlation = buildCorrelation(
    ctx,
    relationInfo,
    parentAlias,
    targetAlias
  );

  // Build inner where if provided
  let whereCondition = correlation;

  if (typeof config === "object" && config !== null && "where" in config) {
    const childCtx = createChildContext(
      ctx,
      relationInfo.targetModel,
      targetAlias
    );
    // Use the raw where clause directly - it's already validated by the parent schema
    const rawWhere = (config as { where: Record<string, unknown> }).where;
    const innerWhere = buildWhere(childCtx, rawWhere, targetAlias);
    if (innerWhere) {
      whereCondition = adapter.operators.and(correlation, innerWhere);
    }
  }

  // Build COUNT subquery
  return adapter.subqueries.scalar(
    sql`SELECT COUNT(*) FROM ${targetTable} WHERE ${whereCondition}`
  );
}

/**
 * Build a COUNT subquery for manyToMany relation through junction table
 */
function buildManyToManyCount(
  ctx: QueryContext,
  relationInfo: RelationInfo,
  config: unknown,
  parentAlias: string
): Sql {
  const { adapter } = ctx;

  const junctionAlias = ctx.nextAlias();
  const targetAlias = ctx.nextAlias();

  const joinInfo = getManyToManyJoinInfo(ctx, relationInfo);
  const { correlationCondition, joinCondition, fromClause } =
    buildManyToManyJoinParts(
      ctx,
      joinInfo,
      parentAlias,
      junctionAlias,
      targetAlias
    );

  const conditions: Sql[] = [correlationCondition, joinCondition];

  // Add inner where if provided
  if (typeof config === "object" && config !== null && "where" in config) {
    const childCtx = createChildContext(
      ctx,
      relationInfo.targetModel,
      targetAlias
    );
    const rawWhere = (config as { where: Record<string, unknown> }).where;
    const whereSchema = relationInfo.targetModel["~"].schemas.where;
    const normalizedWhere = whereSchema
      ? (parse(whereSchema, rawWhere) as { value: Record<string, unknown> })
          .value
      : rawWhere;
    const innerWhere = buildWhere(childCtx, normalizedWhere, targetAlias);
    if (innerWhere) {
      conditions.push(innerWhere);
    }
  }

  const whereCondition = adapter.operators.and(...conditions);

  return adapter.subqueries.scalar(
    sql`SELECT COUNT(*) FROM ${fromClause} WHERE ${whereCondition}`
  );
}
