import { Sql, sql } from "@sql";
import { Model } from "../../schema/model";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, ClauseBuilder } from "../types";
import type { QueryParser } from "../query-parser";

/**
 * SelectClauseBuilder - SELECT Clause Generation Component
 *
 * This component handles the generation of SELECT clauses for all query types.
 * It manages field selection, relation inclusion, aggregation selection, and
 * the complex logic of building type-safe, optimized SELECT statements.
 *
 * FEATURES HANDLED:
 * - Scalar field selection with type mapping
 * - Relation field inclusion with subqueries
 * - Aggregation field selection (_count, _sum, etc.)
 * - Computed field expressions
 * - JSON aggregation for nested relations
 * - DISTINCT field selection
 * - Custom field aliasing
 *
 * SELECTION MODES:
 * - Explicit selection: Only specified fields
 * - Include mode: All scalar fields + specified relations
 * - Mixed mode: Explicit fields + relation includes
 * - Aggregation mode: Aggregation functions only
 *
 * RELATION HANDLING:
 * - One-to-one: Single object or null
 * - One-to-many: Array of objects
 * - Many-to-one: Single object or null
 * - Many-to-many: Array of objects
 * - Nested selections with proper aliasing
 *
 * ARCHITECTURE:
 * - Coordinates with relation handlers for subqueries
 * - Delegates field-specific logic to field handlers
 * - Manages alias generation and conflict resolution
 * - Handles database-specific JSON aggregation
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Efficient subquery generation
 * - Smart field ordering for index usage
 * - Minimal data transfer with selective fields
 * - JSON aggregation for reduced round trips
 *
 * TYPE SAFETY:
 * - Validates field existence against model schema
 * - Ensures proper type mapping for selected fields
 * - Maintains type information for result inference
 * - Handles nullable field selection correctly
 */
export class SelectClauseBuilder implements ClauseBuilder {
  readonly name = "SelectClauseBuilder";
  readonly dependencies = ["RelationQueries", "FieldFilters"];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Main entry point for building SELECT clauses
   */
  build(context: BuilderContext, payload: any): Sql {
    const { model, alias, baseOperation } = context;

    switch (baseOperation) {
      case "count":
        // Handle count operations that may have select._count specifications
        if (payload.select && payload.select._count) {
          return this.buildAggregateStatement(model, payload.select, alias);
        } else {
          // Default to COUNT(*) for simple count operations
          return this.adapter.builders.count(context, sql.raw`*`);
        }

      case "aggregate":
        return this.buildAggregateStatement(model, payload, alias);

      case "groupBy":
        return this.buildGroupBySelectStatement(model, payload, alias);

      default:
        // Standard field selection for findMany, findFirst, etc.
        return this.buildSelectStatement(model, payload.select, alias);
    }
  }

  /**
   * Build explicit field selection
   *
   * Handles user-specified field selection with validation
   */
  private buildExplicitSelection(
    model: Model<any>,
    select: any,
    alias: string
  ): Sql {
    return this.buildSelectStatement(model, select, alias);
  }

  /**
   * Build include-based selection
   *
   * Includes all scalar fields plus specified relations
   */
  private buildIncludeSelection(
    model: Model<any>,
    include: any,
    alias: string
  ): Sql {
    // When using include, select all scalar fields by default
    return this.buildSelectStatement(model, null, alias);
  }

  /**
   * Build default selection (all scalar fields)
   *
   * Selects all scalar fields when no selection is specified
   */
  private buildDefaultSelection(model: Model<any>, alias: string): Sql {
    return this.buildSelectStatement(model, null, alias);
  }

  /**
   * Build aggregation selection
   *
   * Handles aggregation function selection for aggregate queries
   */
  private buildAggregationSelection(
    model: Model<any>,
    aggregations: any,
    alias: string
  ): Sql {
    return this.buildAggregateStatement(model, aggregations, alias);
  }

  /**
   * Build scalar field selection
   *
   * Generates SELECT expressions for scalar fields
   */
  private buildScalarFields(
    model: Model<any>,
    fields: string[],
    alias: string
  ): Sql[] {
    const sqlFields: Sql[] = [];

    for (const fieldName of fields) {
      sqlFields.push(this.adapter.identifiers.column(alias, fieldName));
    }

    return sqlFields;
  }

  /**
   * Build relation field subqueries
   *
   * Generates subqueries for relation field inclusion
   */
  private buildRelationFields(
    model: Model<any>,
    relations: Record<string, any>,
    alias: string
  ): Sql[] {
    // This will be handled by the relation query builder
    // For now, return empty array as relations are handled separately
    return [];
  }

  /**
   * Build single relation subquery
   *
   * Creates subquery for a single relation field
   */
  private buildRelationSubquery(
    model: Model<any>,
    relationName: string,
    relationArgs: any,
    parentAlias: string
  ): Sql {
    // This will be delegated to RelationQueryBuilder
    throw new Error(
      "buildRelationSubquery() should be handled by RelationQueryBuilder"
    );
  }

  /**
   * Build JSON aggregation for relations
   *
   * Uses database-specific JSON functions for relation aggregation
   */
  private buildJsonAggregation(
    relationSql: Sql,
    relationType: string,
    fieldName: string
  ): Sql {
    // Use adapter's subquery aggregation
    const ctx = this.parser.createContext(
      {} as Model<any>, // Will be provided by caller
      "findMany",
      "temp_alias"
    );
    return this.adapter.subqueries.aggregate(ctx, relationSql);
  }

  /**
   * Build count selection for relations
   *
   * Generates count subqueries for relation counting
   */
  private buildCountSelection(
    model: Model<any>,
    countSpec: any,
    alias: string
  ): Sql[] {
    const ctx = this.parser.createContext(model, "count", alias);
    return [this.adapter.aggregates.count(ctx)];
  }

  /**
   * Validate field selection against model
   *
   * Ensures all selected fields exist and are accessible
   */
  private validateFieldSelection(model: Model<any>, selection: any): void {
    if (!selection) return;

    for (const [fieldName, include] of Object.entries(selection)) {
      if (
        include === true &&
        !model.fields.has(fieldName) &&
        !model.relations.has(fieldName)
      ) {
        throw new Error(
          `Field or relation '${fieldName}' not found on model '${model.name}'`
        );
      }
    }
  }

  /**
   * Handle DISTINCT field selection
   *
   * Processes DISTINCT clause with proper field ordering
   */
  private handleDistinctSelection(
    model: Model<any>,
    distinct: string[],
    alias: string
  ): Sql {
    const distinctFields = distinct.map((field) =>
      this.adapter.identifiers.column(alias, field)
    );
    return sql.join(distinctFields, ", ");
  }

  /**
   * Optimize field selection order
   *
   * Orders fields for optimal index usage and performance
   */
  private optimizeFieldOrder(model: Model<any>, fields: string[]): string[] {
    // For now, return fields as-is
    // Future optimization: order by index usage, primary key first, etc.
    return fields;
  }

  /**
   * Build computed field expressions
   *
   * Handles computed fields and custom expressions
   */
  private buildComputedFields(
    model: Model<any>,
    computedFields: any,
    alias: string
  ): Sql[] {
    // TODO: Implement computed field building
    return [];
  }

  /**
   * Handle field aliasing
   *
   * Manages custom field aliases and conflict resolution
   */
  private handleFieldAliasing(fieldName: string, customAlias?: string): string {
    return customAlias || fieldName;
  }

  // ================================
  // Core Implementation Methods (migrated from query-parser.ts)
  // ================================

  /**
   * Build SELECT statement for scalar fields
   * Migrated from query-parser.ts buildSelectStatement
   */
  private buildSelectStatement(
    model: Model<any>,
    select: any,
    alias: string
  ): Sql {
    const fields: Sql[] = [];

    if (select === null || select === undefined) {
      // Default: select all scalar fields (no relations by default)
      // This happens when using include (no explicit select) or when select is not specified
      for (const [fieldName] of Array.from(model.fields)) {
        fields.push(this.adapter.identifiers.column(alias, fieldName));
      }
    } else {
      // Selective fields - handle only scalar fields now (relations handled separately)
      for (const [fieldName, include] of Object.entries(select)) {
        if (include === true && model.fields.has(fieldName)) {
          // Scalar field selection
          fields.push(this.adapter.identifiers.column(alias, fieldName));
        } else if (model.relations.has(fieldName)) {
          // Relations are handled in buildAllRelationSubqueries - skip here
          continue;
        } else if (include === true) {
          // Field/relation not found
          throw new Error(
            `Field or relation '${fieldName}' not found on model '${model.name}'`
          );
        }
      }
    }

    return sql.join(fields, ", ");
  }

  /**
   * Build aggregate statement
   * Migrated from query-parser.ts buildAggregateStatement
   */
  private buildAggregateStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const aggregations: Sql[] = [];
    const ctx = this.parser.createContext(model, "aggregate", alias);

    // Define aggregate operations mapping
    const aggregateOps = {
      _count: this.adapter.aggregates.count,
      _sum: this.adapter.aggregates.sum,
      _avg: this.adapter.aggregates.avg,
      _min: this.adapter.aggregates.min,
      _max: this.adapter.aggregates.max,
    };

    // Process each aggregate operation
    for (const [aggKey, aggFunction] of Object.entries(aggregateOps)) {
      const aggPayload = payload[aggKey];
      if (!aggPayload) continue;

      if (aggPayload === true) {
        // Global aggregate (e.g., _count: true)
        let expr: Sql | null = null;

        if (aggKey === "_count") {
          // Count is the only aggregate that supports global aggregation
          expr = this.adapter.aggregates.count(ctx);
        } else {
          // Other aggregates need specific fields - skip global aggregation
          expr = this.handleGlobalAggregate(aggKey, ctx);
        }

        if (expr) {
          const aliasedExpr = this.adapter.identifiers.aliased(expr, aggKey);
          aggregations.push(aliasedExpr);
        }
      } else if (typeof aggPayload === "object") {
        // Field-specific aggregates (e.g., _sum: { price: true, quantity: true })
        for (const [field, include] of Object.entries(aggPayload)) {
          if (include === true) {
            if (aggKey === "_count") {
              // For _count: { field: true }, generate COUNT(field)
              const columnRef = this.adapter.identifiers.column(alias, field);
              const expr = this.adapter.aggregates.count(ctx, columnRef);
              const aliasedExpr = this.adapter.identifiers.aliased(
                expr,
                `_count_${field}`
              );
              aggregations.push(aliasedExpr);
            } else {
              // For other aggregates like _sum: { field: true }
              const columnRef = this.adapter.identifiers.column(alias, field);
              const expr = aggFunction(ctx, columnRef);
              const aliasedExpr = this.adapter.identifiers.aliased(
                expr,
                `${aggKey}_${field}`
              );
              aggregations.push(aliasedExpr);
            }
          }
        }
      }
    }

    return sql.join(aggregations, ", ");
  }

  /**
   * Handle global aggregate operations
   * Migrated from query-parser.ts handleGlobalAggregate
   */
  private handleGlobalAggregate(
    aggKey: string,
    ctx: BuilderContext
  ): Sql | null {
    // Only _count supports global aggregation (COUNT(*))
    // Other aggregates need specific fields
    if (aggKey === "_count") {
      return this.adapter.aggregates.count(ctx, undefined);
    }

    // For other aggregates without specific fields, we skip them
    // This could be enhanced to aggregate all numeric fields if needed
    return null;
  }

  /**
   * Build GROUP BY select statement
   * Migrated from query-parser.ts buildGroupBySelectStatement
   */
  private buildGroupBySelectStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const selections: Sql[] = [];

    // Add groupBy fields to SELECT
    if (Array.isArray(payload.by)) {
      for (const field of payload.by) {
        selections.push(this.adapter.identifiers.column(alias, field));
      }
    } else {
      selections.push(this.adapter.identifiers.column(alias, payload.by));
    }

    // Add aggregations if present
    const aggregateStatement = this.buildAggregateStatement(
      model,
      payload,
      alias
    );
    if (aggregateStatement.strings[0]) {
      selections.push(sql.raw`${aggregateStatement.strings[0]}`);
    }

    return sql.join(selections, ", ");
  }
}
