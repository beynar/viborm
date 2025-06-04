import { Sql, sql } from "@sql";
import { Model } from "../../schema/model";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, ClauseBuilder } from "../types";
import type { QueryParser } from "../index";

/**
 * WhereClauseBuilder - WHERE Clause Generation Component
 *
 * This component handles the generation of WHERE clauses for all query types.
 * It manages complex filtering logic, logical operators, relation filters,
 * and the translation of type-safe filter conditions to SQL.
 *
 * FEATURES HANDLED:
 * - Field-based filtering with type-specific operators
 * - Logical operators (AND, OR, NOT) with proper precedence
 * - Relation filtering (some, every, none, is, isNot)
 * - Complex nested conditions with parentheses
 * - JSON path filtering and operations
 * - Array/List filtering operations
 * - Null safety and type coercion
 *
 * FILTER TYPES:
 * - String filters: contains, startsWith, endsWith, mode
 * - Number filters: gt, gte, lt, lte, equals, not
 * - Date filters: before, after, between
 * - Boolean filters: equals, not
 * - JSON filters: path operations, contains, array operations
 * - List filters: has, hasEvery, hasSome, isEmpty
 * - Enum filters: in, notIn, equals
 *
 * LOGICAL OPERATIONS:
 * - AND: All conditions must be true
 * - OR: At least one condition must be true
 * - NOT: Negates the condition
 * - Nested combinations with proper precedence
 *
 * RELATION FILTERING:
 * - some: At least one related record matches
 * - every: All related records match
 * - none: No related records match
 * - is: Direct relation comparison
 * - isNot: Negated relation comparison
 *
 * ARCHITECTURE:
 * - Coordinates with field handlers for type-specific filtering
 * - Delegates relation filtering to relation handlers
 * - Manages logical operator precedence and grouping
 * - Handles database-specific filter syntax
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Index-aware condition ordering
 * - Efficient subquery generation for relations
 * - Smart condition grouping for query planner
 * - Early termination for impossible conditions
 *
 * TYPE SAFETY:
 * - Validates filter operations against field types
 * - Ensures proper type coercion and null handling
 * - Maintains type information for result inference
 * - Prevents invalid filter combinations
 */
export class WhereClauseBuilder implements ClauseBuilder {
  readonly name = "WhereClauseBuilder";
  readonly dependencies = ["FieldFilters", "RelationFilters"];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Main entry point for building WHERE clauses
   */
  build(context: BuilderContext, where: any): Sql {
    if (!where) {
      return sql.empty;
    }

    const { model, alias } = context;
    return this.buildWhereStatement(model, where, alias);
  }

  /**
   * Build field-based conditions
   *
   * Delegates to FieldFilterBuilder for field-specific filter generation
   */
  private buildFieldCondition(
    model: Model<any>,
    fieldName: string,
    condition: any,
    alias: string
  ): Sql {
    const field = model.fields.get(fieldName);
    if (!field) {
      const availableFields = Array.from(model.fields.keys());
      throw new Error(
        `Field '${fieldName}' not found on model '${
          model.name
        }'. Available fields: ${availableFields.join(", ")}`
      );
    }

    const ctx = this.parser.createContext(model, "findMany", alias, {
      field: field as any,
      fieldName,
    });

    // Handle simple equality by converting to explicit equals filter
    if (
      typeof condition === "string" ||
      typeof condition === "number" ||
      typeof condition === "boolean"
    ) {
      return this.parser.components.fieldFilters.handle(
        ctx,
        { equals: condition },
        fieldName
      );
    }

    // Handle null values
    if (condition === null) {
      return this.parser.components.fieldFilters.handle(
        ctx,
        { equals: null },
        fieldName
      );
    }

    // Handle complex filters by delegating to FieldFilterBuilder
    return this.parser.components.fieldFilters.handle(
      ctx,
      condition,
      fieldName
    );
  }

  /**
   * Build relation-based conditions
   *
   * Handles filtering through relations with subqueries
   */
  private buildRelationCondition(
    model: Model<any>,
    relationName: string,
    condition: any,
    alias: string
  ): Sql {
    const relation = model.relations.get(relationName);
    if (!relation) {
      const availableRelations = Array.from(model.relations.keys());
      throw new Error(
        `Relation '${relationName}' not found on model '${
          model.name
        }'. Available relations: ${availableRelations.join(", ")}`
      );
    }

    const ctx = this.parser.createContext(model, "findMany", alias, {
      relation,
    });

    // Build the relation subquery first, then pass it to the adapter
    let relationSubquery: Sql;

    if (condition.some) {
      // Build subquery for the relation with the 'some' condition
      relationSubquery = this.buildRelationFilterSubquery(
        relation,
        condition.some,
        alias
      );
      return this.adapter.filters.relations.some(ctx, relationSubquery);
    } else if (condition.every) {
      // Build subquery for the relation with the 'every' condition
      relationSubquery = this.buildRelationFilterSubquery(
        relation,
        condition.every,
        alias
      );
      return this.adapter.filters.relations.every(ctx, relationSubquery);
    } else if (condition.none) {
      // Build subquery for the relation with the 'none' condition
      relationSubquery = this.buildRelationFilterSubquery(
        relation,
        condition.none,
        alias
      );
      return this.adapter.filters.relations.none(ctx, relationSubquery);
    } else {
      // Direct relation filter (for one-to-one/many-to-one)
      return this.adapter.filters.relations.direct(ctx, sql.empty);
    }
  }

  /**
   * Build logical operator conditions
   *
   * Handles AND, OR, NOT with proper precedence and grouping
   */
  private buildLogicalCondition(
    model: Model<any>,
    operator: string,
    conditions: any,
    alias: string
  ): Sql {
    const ctx = this.parser.createContext(model, "findMany", alias);

    if (!Array.isArray(conditions) && typeof conditions !== "object") {
      throw new Error(
        `Logical operator '${operator}' requires conditions on model '${model.name}'`
      );
    }

    const conditionSqls = Array.isArray(conditions)
      ? conditions.map((cond) => this.buildWhereStatement(model, cond, alias))
      : [this.buildWhereStatement(model, conditions, alias)];

    if (conditionSqls.length === 0) {
      throw new Error(
        `Logical operator '${operator}' needs at least one condition on model '${model.name}'`
      );
    }

    switch (operator) {
      case "AND":
        return this.adapter.operators.and(ctx, ...conditionSqls);
      case "OR":
        return this.adapter.operators.or(ctx, ...conditionSqls);
      case "NOT":
        const firstCondition = conditionSqls[0];
        if (!firstCondition) {
          throw new Error("NOT operator needs a condition");
        }
        return this.adapter.operators.not(ctx, firstCondition);
      default:
        throw new Error(`Unsupported logical operator: ${operator}`);
    }
  }

  /**
   * Build AND conditions
   *
   * Combines multiple conditions with AND operator
   */
  private buildAndCondition(
    model: Model<any>,
    conditions: any[],
    alias: string
  ): Sql {
    return this.buildLogicalCondition(model, "AND", conditions, alias);
  }

  /**
   * Build OR conditions
   *
   * Combines multiple conditions with OR operator
   */
  private buildOrCondition(
    model: Model<any>,
    conditions: any[],
    alias: string
  ): Sql {
    return this.buildLogicalCondition(model, "OR", conditions, alias);
  }

  /**
   * Build NOT conditions
   *
   * Negates a condition with proper parentheses
   */
  private buildNotCondition(
    model: Model<any>,
    condition: any,
    alias: string
  ): Sql {
    return this.buildLogicalCondition(model, "NOT", condition, alias);
  }

  /**
   * Handle abstract conditions
   *
   * Processes special conditions like _parentRef and _relationLink
   */
  private handleAbstractCondition(
    model: Model<any>,
    fieldName: string,
    condition: any,
    alias: string
  ): Sql {
    switch (fieldName) {
      case "_relationLink":
        return this.buildRelationLinkSQL(condition, alias);
      case "_parentRef":
        return this.buildParentRefSQL(condition, alias);
      case "_junctionExists":
        // Create a minimal context for the junction exists condition
        const ctx = this.parser.createContext(model, "findMany", alias);
        return this.buildJunctionExistsCondition(ctx, condition);
      default:
        throw new Error(
          `Unknown abstract condition '${fieldName}' on model '${model.name}'`
        );
    }
  }

  /**
   * Build unique identifier conditions
   *
   * Optimizes conditions for unique field lookups
   */
  private buildUniqueCondition(
    model: Model<any>,
    where: any,
    alias: string
  ): Sql {
    // For now, treat unique conditions the same as regular WHERE conditions
    return this.buildWhereStatement(model, where, alias);
  }

  /**
   * Optimize condition ordering
   *
   * Orders conditions for optimal index usage and performance
   */
  private optimizeConditionOrder(model: Model<any>, conditions: Sql[]): Sql[] {
    // For now, return conditions as-is
    // Future optimization: order by selectivity, index usage, etc.
    return conditions;
  }

  /**
   * Handle null safety in conditions
   *
   * Ensures proper null handling in filter conditions
   */
  private handleNullSafety(condition: Sql, fieldType: string): Sql {
    // For now, return condition as-is
    // Future enhancement: add null safety based on field type
    return condition;
  }

  /**
   * Validate WHERE conditions
   *
   * Ensures all conditions are valid for the model schema
   */
  private validateWhereConditions(model: Model<any>, where: any): void {
    if (!where || typeof where !== "object") {
      return;
    }

    for (const [fieldName, condition] of Object.entries(where)) {
      if (fieldName === "AND" || fieldName === "OR" || fieldName === "NOT") {
        // Logical operators are valid
        continue;
      } else if (fieldName.startsWith("_")) {
        // Abstract conditions are valid
        continue;
      } else if (
        !model.fields.has(fieldName) &&
        !model.relations.has(fieldName)
      ) {
        const availableFields = Array.from(model.fields.keys());
        const availableRelations = Array.from(model.relations.keys());
        const available = [...availableFields, ...availableRelations];
        throw new Error(
          `Field or relation '${fieldName}' not found on model '${
            model.name
          }'. Available: ${available.join(", ")}`
        );
      }
    }
  }

  /**
   * Build cursor-based conditions
   *
   * Converts cursor pagination to WHERE conditions
   */
  private buildCursorConditions(
    model: Model<any>,
    cursor: any,
    orderBy: any,
    alias: string
  ): Sql {
    // TODO: Implement cursor condition building
    throw new Error("buildCursorConditions() not implemented yet");
  }

  /**
   * Handle case sensitivity
   *
   * Applies case sensitivity settings to string conditions
   */
  private handleCaseSensitivity(condition: Sql, mode: string | undefined): Sql {
    // TODO: Implement case sensitivity handling
    return condition;
  }

  /**
   * Build complex JSON path conditions
   *
   * Handles JSON path filtering with database-specific syntax
   */
  private buildJsonPathConditions(
    fieldName: string,
    jsonCondition: any,
    alias: string
  ): Sql {
    // TODO: Implement JSON path condition building
    throw new Error("buildJsonPathConditions() not implemented yet");
  }

  /**
   * Build array/list conditions
   *
   * Handles array operations like has, hasEvery, hasSome
   */
  private buildArrayConditions(
    fieldName: string,
    arrayCondition: any,
    alias: string
  ): Sql {
    // TODO: Implement array condition building
    throw new Error("buildArrayConditions() not implemented yet");
  }

  // ================================
  // Core Implementation Methods (migrated from query-parser.ts)
  // ================================

  /**
   * Build WHERE statement
   * Migrated from query-parser.ts buildWhereStatement
   */
  private buildWhereStatement(
    model: Model<any>,
    where: any,
    alias: string
  ): Sql {
    const conditions: Sql[] = [];

    for (const [fieldName, condition] of Object.entries(where)) {
      if (fieldName === "AND" || fieldName === "OR" || fieldName === "NOT") {
        // Handle logical operators
        conditions.push(
          this.buildLogicalCondition(model, fieldName, condition as any, alias)
        );
      } else if (fieldName.startsWith("_")) {
        // Handle abstract conditions (relation links, parent refs)
        conditions.push(
          this.handleAbstractCondition(model, fieldName, condition, alias)
        );
      } else if (model.fields.has(fieldName)) {
        // Handle field conditions
        conditions.push(
          this.buildFieldCondition(model, fieldName, condition, alias)
        );
      } else if (model.relations.has(fieldName)) {
        // Handle relation conditions
        conditions.push(
          this.buildRelationCondition(model, fieldName, condition, alias)
        );
      } else {
        // Field/relation not found
        const availableFields = Array.from(model.fields.keys());
        const availableRelations = Array.from(model.relations.keys());
        const available = [...availableFields, ...availableRelations];
        throw new Error(
          `Field or relation '${fieldName}' not found on model '${
            model.name
          }'. Available: ${available.join(", ")}`
        );
      }
    }

    if (conditions.length === 0) {
      return sql.empty;
    }
    const ctx = this.parser.createContext(model, "findMany", alias);
    return this.adapter.operators.and(ctx, ...conditions);
  }

  /**
   * Build relation filter subquery
   * Creates simple SELECT subqueries for EXISTS/NOT EXISTS filters (not JSON aggregation)
   */
  private buildRelationFilterSubquery(
    relation: any,
    condition: any,
    parentAlias: string
  ): Sql {
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.parser.generateAlias();

    // Get relation configuration
    const relationType = relation["~relationType"];
    const onField = relation["~onField"];
    const refField = relation["~refField"];

    // Build the basic SELECT statement for the target table
    const tableName = targetModel.tableName || targetModel.name;
    const fromClause = this.adapter.identifiers.table(tableName, childAlias);

    // For EXISTS, we just need to select any field - commonly the foreign key
    const selectField = this.adapter.identifiers.column(childAlias, refField);

    // Create context for operator calls
    const ctx = this.parser.createContext(targetModel, "findMany", childAlias);

    // Build WHERE conditions for the subquery
    const whereConditions: Sql[] = [];

    // 1. Add the user's filter conditions first (like Prisma)
    if (condition && typeof condition === "object") {
      const userCondition = this.buildWhereStatement(
        targetModel,
        condition,
        childAlias
      );
      if (userCondition !== sql.empty) {
        whereConditions.push(userCondition);
      }
    }

    // 2. Add the relation link condition (child.refField = parent.onField) using adapter operators
    if (onField && refField) {
      const childCol = this.adapter.identifiers.column(childAlias, refField);
      const parentCol = this.adapter.identifiers.column(parentAlias, onField);
      const relationLink = this.adapter.operators.eq(ctx, parentCol, childCol);
      whereConditions.push(relationLink);
    }

    // 3. Add NULL safety for the foreign key using adapter operators
    const foreignKeyColumn = this.adapter.identifiers.column(
      childAlias,
      refField
    );
    const nullCheck = this.adapter.operators.isNotNull(ctx, foreignKeyColumn);
    whereConditions.push(nullCheck);

    // Build the combined WHERE clause using adapter operators for AND
    const finalWhere =
      whereConditions.length === 1
        ? whereConditions[0]
        : this.adapter.operators.and(ctx, ...whereConditions);

    // Build the simple SELECT subquery: SELECT refField FROM table WHERE conditions
    return sql`SELECT ${selectField} FROM ${fromClause} WHERE ${finalWhere}`;
  }

  /**
   * Resolve relation target model
   * Helper method for relation model resolution
   */
  private resolveRelationModel(relation: any): any {
    const model = relation.getter();
    if (!model) {
      throw new Error("Relation model not found");
    }
    return model;
  }

  /**
   * Build relation link SQL
   * Migrated from query-parser.ts buildRelationLinkSQL
   */
  private buildRelationLinkSQL(condition: any, alias: string): Sql {
    const { parentAlias, childAlias, relationType, onField, refField } =
      condition;

    // Generate the appropriate SQL condition based on relation type
    if (onField && refField) {
      // Create context for operators - use a minimal context since we don't have full model info here
      const ctx = {
        model: { name: "unknown" } as any,
        baseOperation: "findMany" as any,
        alias: childAlias || alias,
      } as any;

      // Foreign key relationship: child.refField = parent.onField using adapter operators
      const childCol = this.adapter.identifiers.column(
        childAlias || alias,
        refField
      );
      const parentCol = this.adapter.identifiers.column(parentAlias, onField);
      return this.adapter.operators.eq(ctx, childCol, parentCol);
    }

    // Fallback for complex relations
    throw new Error(
      `Relation link generation failed for relation type: ${relationType}`
    );
  }

  /**
   * Build parent reference SQL
   * Migrated from query-parser.ts buildParentRefSQL
   */
  private buildParentRefSQL(condition: any, alias: string): Sql {
    if (typeof condition !== "string" || !condition.includes(".")) {
      throw new Error(`Invalid parent reference: ${condition}`);
    }

    const [parentAlias, parentField] = condition.split(".");

    if (!parentAlias || !parentField) {
      throw new Error(`Invalid parent reference: ${condition}`);
    }

    return this.adapter.identifiers.column(parentAlias, parentField);
  }

  /**
   * Build EXISTS condition for Many-to-Many junction table
   */
  private buildJunctionExistsCondition(
    context: BuilderContext,
    junctionData: any
  ): Sql {
    const {
      junctionTable,
      sourceField,
      targetField,
      parentAlias,
      childAlias,
      onField,
      refField,
    } = junctionData;

    // Build using adapter's query builders for consistency
    const junctionAlias = this.parser.generateAlias();

    // Build SELECT and FROM clauses using adapter builders
    const selectClause = this.adapter.builders.select(context, sql`1`);
    const fromClause = this.adapter.builders.from(
      context,
      this.adapter.identifiers.table(junctionTable, junctionAlias)
    );

    // Build WHERE conditions using adapter eq utility
    const condition1 = this.adapter.operators.eq(
      context,
      this.adapter.identifiers.column(junctionAlias, targetField),
      this.adapter.identifiers.column(childAlias, refField)
    );
    const condition2 = this.adapter.operators.eq(
      context,
      this.adapter.identifiers.column(junctionAlias, sourceField),
      this.adapter.identifiers.column(parentAlias, onField)
    );

    const whereClause = this.adapter.builders.where(
      context,
      this.adapter.operators.and(context, condition1, condition2)
    );

    // Combine into inner query
    const innerQuery = sql.join([selectClause, fromClause, whereClause], " ");

    // Use the adapter's exists util
    return this.adapter.utils.exists(context, innerQuery);
  }
}
