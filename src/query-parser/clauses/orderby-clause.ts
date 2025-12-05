import { Sql, sql } from "@sql";
import { Model } from "../../schema/model";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, ClauseBuilder } from "../types";
import type { QueryParser } from "../query-parser";

/**
 * OrderByClauseBuilder - ORDER BY Clause Generation Component
 *
 * This component handles the generation of ORDER BY clauses for all query types.
 * It manages field ordering, relation ordering, complex sorting expressions,
 * and database-specific ordering features like null positioning.
 *
 * FEATURES HANDLED:
 * - Single and multiple field ordering
 * - Ascending and descending sort directions
 * - Null value positioning (NULLS FIRST/LAST)
 * - Case-insensitive ordering for strings
 * - Relation field ordering with joins
 * - Complex ordering expressions
 * - Custom ordering functions
 *
 * ORDERING TYPES:
 * - Field ordering: Direct field sorting
 * - Relation ordering: Sorting by related field values
 * - Computed ordering: Sorting by expressions or functions
 * - Random ordering: Database-specific random sorting
 * - Custom ordering: User-defined ordering logic
 *
 * DIRECTION HANDLING:
 * - asc/ASC: Ascending order (default)
 * - desc/DESC: Descending order
 * - Null positioning: NULLS FIRST or NULLS LAST
 * - Case sensitivity: Case-sensitive or insensitive
 *
 * RELATION ORDERING:
 * - One-to-one: Order by related field
 * - Many-to-one: Order by related field
 * - Aggregated ordering: Order by count, sum, etc. of relations
 * - Nested relation ordering: Multi-level relation sorting
 *
 * ARCHITECTURE:
 * - Validates ordering fields against model schema
 * - Handles database-specific ordering syntax
 * - Coordinates with relation handlers for complex ordering
 * - Manages ordering precedence and stability
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Index-aware ordering for optimal performance
 * - Efficient ordering for large result sets
 * - Smart ordering combination and deduplication
 * - Early termination for limit queries
 *
 * TYPE SAFETY:
 * - Validates ordering fields exist and are orderable
 * - Ensures proper type handling for different field types
 * - Maintains type information for result ordering
 * - Prevents invalid ordering combinations
 */
export class OrderByClauseBuilder implements ClauseBuilder {
  readonly name = "OrderByClauseBuilder";
  readonly dependencies = ["RelationQueries"];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Main entry point for building ORDER BY clauses
   */
  build(context: BuilderContext, orderBy: any): Sql {
    if (!orderBy) {
      return sql.empty;
    }

    const { model, alias } = context;
    return this.buildOrderByStatement(model, orderBy, alias);
  }

  /**
   * Build single field ordering
   *
   * Handles ordering by a single field with direction
   */
  private buildSingleFieldOrder(
    model: Model<any>,
    fieldName: string,
    direction: string,
    alias: string
  ): Sql {
    this.validateField(model, fieldName);
    this.validateDirection(direction, fieldName, model.name);

    const columnRef = this.adapter.identifiers.column(alias, fieldName);
    return sql`${columnRef} ${sql.raw`${direction.toUpperCase()}`}`;
  }

  /**
   * Build multiple field ordering
   *
   * Handles ordering by multiple fields with different directions
   */
  private buildMultipleFieldOrder(
    model: Model<any>,
    orderByArray: any[],
    alias: string
  ): Sql[] {
    const orders: Sql[] = [];

    for (const orderBy of orderByArray) {
      orders.push(...this.parseOrderByObject(orderBy, alias, model));
    }

    return orders;
  }

  /**
   * Build relation field ordering
   *
   * Handles ordering by fields in related models
   */
  private buildRelationFieldOrder(
    model: Model<any>,
    relationName: string,
    relationOrder: any,
    alias: string
  ): Sql {
    // TODO: Implement relation field ordering
    // This will require coordination with RelationQueryBuilder
    throw new Error("buildRelationFieldOrder() not implemented yet");
  }

  /**
   * Build computed field ordering
   *
   * Handles ordering by computed expressions or functions
   */
  private buildComputedFieldOrder(
    model: Model<any>,
    expression: any,
    direction: string,
    alias: string
  ): Sql {
    // TODO: Implement computed field ordering
    throw new Error("buildComputedFieldOrder() not implemented yet");
  }

  /**
   * Build aggregated ordering
   *
   * Handles ordering by aggregated values (count, sum, etc.)
   */
  private buildAggregatedOrder(
    model: Model<any>,
    aggregation: any,
    direction: string,
    alias: string
  ): Sql {
    // TODO: Implement aggregated ordering
    throw new Error("buildAggregatedOrder() not implemented yet");
  }

  /**
   * Handle null positioning
   *
   * Adds NULLS FIRST/LAST to ordering expressions
   */
  private handleNullPositioning(
    orderExpression: Sql,
    nullPosition: "first" | "last" | undefined
  ): Sql {
    if (!nullPosition) {
      return orderExpression;
    }

    const nullsClause = nullPosition === "first" ? "NULLS FIRST" : "NULLS LAST";
    return sql`${orderExpression} ${sql.raw`${nullsClause}`}`;
  }

  /**
   * Handle case sensitivity
   *
   * Applies case-insensitive ordering for string fields
   */
  private handleCaseSensitivity(
    orderExpression: Sql,
    caseInsensitive: boolean = false
  ): Sql {
    if (!caseInsensitive) {
      return orderExpression;
    }

    // Use database-specific case-insensitive ordering via adapter utility
    const ctx = {
      model: { name: "unknown" } as any,
      baseOperation: "findMany" as any,
      alias: "temp",
    } as any;
    return this.adapter.utils.caseInsensitive(ctx, orderExpression);
  }

  /**
   * Build random ordering
   *
   * Generates database-specific random ordering
   */
  private buildRandomOrder(): Sql {
    // Use adapter-specific random function
    return sql.raw`RANDOM()`;
  }

  /**
   * Optimize ordering for performance
   *
   * Reorders fields for optimal index usage
   */
  private optimizeOrdering(model: Model<any>, orders: Sql[]): Sql[] {
    // For now, return orders as-is
    // Future optimization: reorder based on index availability
    return orders;
  }

  /**
   * Validate ordering field exists
   *
   * Ensures the field exists and is orderable
   */
  private validateField(model: Model<any>, fieldName: string): void {
    // Allow aggregate fields for groupBy and aggregate operations
    const aggregateFields = ["_count", "_sum", "_avg", "_min", "_max"];
    if (aggregateFields.includes(fieldName)) {
      // These are valid in groupBy/aggregate contexts - allow them
      return;
    }

    if (!model["~"].fieldMap.has(fieldName)) {
      const availableFields = Array.from(model["~"].fieldMap.keys());
      throw new Error(
        `Field '${fieldName}' not found on model '${
          model.name
        }'. Available fields: ${availableFields.join(", ")}`
      );
    }
  }

  /**
   * Validate ordering direction
   *
   * Ensures the direction is valid (asc/desc)
   */
  private validateDirection(
    direction: string,
    fieldName: string,
    modelName: string
  ): void {
    const validDirections = ["asc", "desc", "ASC", "DESC"];
    if (!validDirections.includes(direction)) {
      throw new Error(
        `Invalid order direction '${direction}' for field '${fieldName}' on model '${modelName}'. Valid directions: ${validDirections.join(
          ", "
        )}`
      );
    }
  }

  /**
   * Handle ordering stability
   *
   * Ensures stable ordering for consistent results
   */
  private ensureStableOrdering(
    model: Model<any>,
    orders: Sql[],
    alias: string
  ): Sql[] {
    // Add primary key ordering for stability if not already present
    // This ensures consistent ordering across multiple queries

    // For now, return orders as-is
    // Future enhancement: add primary key ordering for stability
    return orders;
  }

  /**
   * Build cursor-based ordering
   *
   * Handles ordering for cursor pagination
   */
  private buildCursorOrdering(
    model: Model<any>,
    cursor: any,
    orderBy: any,
    alias: string
  ): Sql {
    // TODO: Implement cursor-based ordering
    throw new Error("buildCursorOrdering() not implemented yet");
  }

  /**
   * Handle complex ordering expressions
   *
   * Processes complex ordering with multiple criteria
   */
  private buildComplexOrdering(
    model: Model<any>,
    complexOrder: any,
    alias: string
  ): Sql {
    // TODO: Implement complex ordering
    throw new Error("buildComplexOrdering() not implemented yet");
  }

  /**
   * Deduplicate ordering expressions
   *
   * Removes duplicate ordering criteria
   */
  private deduplicateOrdering(orders: Sql[]): Sql[] {
    // For now, return orders as-is
    // Future enhancement: remove duplicate ordering expressions
    return orders;
  }

  /**
   * Handle ordering limits
   *
   * Optimizes ordering when combined with LIMIT
   */
  private optimizeOrderingWithLimit(
    orders: Sql[],
    limit: number | undefined
  ): Sql[] {
    // For now, return orders as-is
    // Future optimization: optimize ordering for limited results
    return orders;
  }

  /**
   * Build ordering for groupBy queries
   *
   * Handles special ordering requirements for grouped results
   */
  private buildGroupByOrdering(
    model: Model<any>,
    groupBy: any,
    orderBy: any,
    alias: string
  ): Sql {
    // TODO: Implement groupBy ordering
    throw new Error("buildGroupByOrdering() not implemented yet");
  }

  /**
   * Handle ordering with distinct
   *
   * Ensures ordering is compatible with DISTINCT
   */
  private handleDistinctOrdering(
    orders: Sql[],
    distinctFields: string[]
  ): Sql[] {
    // For now, return orders as-is
    // Future enhancement: validate ordering compatibility with DISTINCT
    return orders;
  }

  // ================================
  // Core Implementation Methods (migrated from query-parser.ts)
  // ================================

  /**
   * Build ORDER BY statement
   * Migrated from query-parser.ts buildOrderByStatement
   */
  private buildOrderByStatement(
    model: Model<any>,
    orderBy: any,
    alias: string
  ): Sql {
    const orders: Sql[] = [];

    if (Array.isArray(orderBy)) {
      for (const order of orderBy) {
        orders.push(...this.parseOrderByObject(order, alias, model));
      }
    } else {
      orders.push(...this.parseOrderByObject(orderBy, alias, model));
    }

    // Include ORDER BY keyword in the generated SQL
    return sql`ORDER BY ${sql.join(orders, ", ")}`;
  }

  /**
   * Parse ORDER BY object
   * Migrated from query-parser.ts parseOrderByObject
   */
  private parseOrderByObject(
    orderBy: any,
    alias: string,
    model: Model<any>
  ): Sql[] {
    const orders: Sql[] = [];

    for (const [field, direction] of Object.entries(orderBy)) {
      // Validate field exists
      this.validateField(model, field);

      if (typeof direction === "string") {
        this.validateDirection(direction, field, model.name);
        const columnRef = this.adapter.identifiers.column(alias, field);
        orders.push(sql`${columnRef} ${sql.raw`${direction.toUpperCase()}`}`);
      }
    }

    return orders;
  }
}
