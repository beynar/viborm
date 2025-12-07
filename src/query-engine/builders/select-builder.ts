/**
 * Select Builder
 *
 * Builds SELECT columns from select/include inputs.
 * Handles scalar fields and delegates relations to include-builder.
 */

import { sql, Sql } from "@sql";
import type { QueryContext } from "../types";
import { QueryEngineError } from "../types";
import {
  getScalarFieldNames,
  isRelation,
  getRelationInfo,
  getColumnName,
} from "../context";
import { buildInclude } from "./include-builder";

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
  // Build field/expression pairs
  const pairs = buildSelectPairs(ctx, select, include, alias);

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
 */
function buildSelectPairs(
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string
): [string, Sql][] {
  const pairs: [string, Sql][] = [];
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
      if (value === undefined || value === false) continue;

      if (isRelation(ctx.model, key)) {
        const relationInfo = getRelationInfo(ctx, key);
        if (relationInfo && typeof value === "object" && value !== null) {
          const relationSql = buildInclude(
            ctx,
            relationInfo,
            value as Record<string, unknown>,
            alias
          );
          pairs.push([key, relationSql]);
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

  // Handle include (adds relations on top of scalars)
  if (include) {
    for (const [key, value] of Object.entries(include)) {
      if (value === undefined || value === false) continue;

      // Check for _count aggregate - not implemented yet
      if (key === "_count") {
        throw new QueryEngineError(
          `'_count' relation aggregation is not implemented. ` +
            `Use a separate count query or groupBy with _count instead.`
        );
      }

      if (isRelation(ctx.model, key)) {
        const relationInfo = getRelationInfo(ctx, key);
        if (relationInfo) {
          const includeValue =
            value === true ? {} : (value as Record<string, unknown>);
          const relationSql = buildInclude(
            ctx,
            relationInfo,
            includeValue,
            alias
          );
          pairs.push([key, relationSql]);
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

  return pairs;
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
 * @returns Object with SQL and column aliases
 */
export function buildSelectWithAliases(
  ctx: QueryContext,
  select: Record<string, unknown> | undefined,
  include: Record<string, unknown> | undefined,
  alias: string,
  options: BuildSelectOptions = {}
): SelectResult {
  // Build field/expression pairs
  const pairs = buildSelectPairs(ctx, select, include, alias);

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

  return { sql: sqlResult, aliases };
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
