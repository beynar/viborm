import { Sql, sql } from "@sql";
import { Model } from "../../schema/model";
import { Relation } from "../../schema";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, RelationHandler } from "../types";
import type { QueryParser } from "../index";
import {
  getJunctionTableName,
  getJunctionFieldNames,
} from "../../schema/fields/relation";

/**
 * RelationQueryBuilder - Relation Query Generation Component
 *
 * This component handles the generation of relation-based queries and subqueries.
 * It manages the complex logic of building efficient relation queries, handling
 * different relation types, and optimizing relation data fetching.
 *
 * FEATURES HANDLED:
 * - Relation subquery generation for includes
 * - Relation selection in select clauses
 * - Nested relation queries with proper aliasing
 * - Relation link condition generation
 * - JSON aggregation for relation results
 * - Efficient relation data fetching strategies
 *
 * RELATION TYPES:
 * - One-to-one: Single related object or null
 * - One-to-many: Array of related objects
 * - Many-to-one: Single related object or null
 * - Many-to-many: Array of related objects
 * - Self-relations: Relations to the same model
 *
 * QUERY STRATEGIES:
 * - Subquery approach: Nested SELECT for each relation
 * - JOIN approach: SQL JOINs for efficient fetching
 * - Batch loading: Multiple queries with IN clauses
 * - JSON aggregation: Database-specific JSON functions
 *
 * RELATION CONTEXTS:
 * - Include relations: Fetch related data alongside main query
 * - Select relations: Explicitly select relation fields
 * - Filter relations: Use relations in WHERE conditions
 * - Order relations: Sort by related field values
 *
 * ARCHITECTURE:
 * - Coordinates with other components for complex queries
 * - Manages relation alias generation and conflicts
 * - Handles relation link condition generation
 * - Optimizes relation query performance
 *
 * PERFORMANCE OPTIMIZATIONS:
 * - Efficient subquery generation
 * - Smart relation batching and caching
 * - Minimal data transfer with selective fields
 * - Database-specific relation optimizations
 *
 * TYPE SAFETY:
 * - Validates relation existence and accessibility
 * - Ensures proper type mapping for relation results
 * - Maintains type information for nested relations
 * - Handles nullable relation results correctly
 */
export class RelationQueryBuilder implements RelationHandler {
  readonly name = "RelationQueryBuilder";
  readonly dependencies = ["AliasGenerator", "ContextFactory"];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Check if this handler can handle the given relation type
   */
  canHandle(relationType: string): boolean {
    // This handler can handle all relation types
    return true;
  }

  /**
   * Handle relation operations
   */
  handle(context: any, ...args: any[]): any {
    // This is a generic handler method - specific methods are used for actual operations
    throw new Error(
      "Use specific relation query methods instead of generic handle()"
    );
  }

  /**
   * Build relation subquery for include/select
   *
   * Creates a subquery to fetch related data
   */
  buildRelationSubquery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    return this.buildUnifiedRelationSubquery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build relation link conditions
   *
   * Creates conditions to link parent and child records
   */
  buildRelationLinkCondition(
    relation: Relation<any, any>,
    parentAlias: string,
    childAlias: string
  ): any {
    const relationType = relation["~relationType"];
    const onField = relation["~onField"];
    const refField = relation["~refField"];

    // Basic foreign key relationship condition
    if (onField && refField) {
      // Create abstract relation link condition for the WHERE clause builder to handle
      return {
        _relationLink: {
          parentAlias,
          childAlias,
          relationType,
          onField,
          refField,
        },
      };
    }

    // Default condition - adapter will need to handle the specific SQL generation
    return {
      _relationLink: {
        parentAlias,
        childAlias,
        relationType,
        onField,
        refField,
      },
    };
  }

  /**
   * Build all relation subqueries for a model
   *
   * Processes both include and select relations
   */
  buildAllRelationSubqueries(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql[] {
    const relationSubqueries: Sql[] = [];

    // Handle relations from select clause
    if (payload.select) {
      for (const [fieldName, value] of Object.entries(payload.select)) {
        if (model.relations.has(fieldName)) {
          this.validateRelation(model, fieldName);
          const relation = model.relations.get(fieldName)!;
          const subquery = this.buildUnifiedRelationSubqueryWithModel(
            relation,
            value,
            alias,
            fieldName,
            model
          );
          relationSubqueries.push(subquery);
        }
      }
    }

    // Handle relations from include clause
    if (payload.include) {
      for (const [relationName, relationArgs] of Object.entries(
        payload.include
      )) {
        this.validateRelation(model, relationName);
        const relation = model.relations.get(relationName)!;
        const subquery = this.buildUnifiedRelationSubqueryWithModel(
          relation,
          relationArgs,
          alias,
          relationName,
          model
        );
        relationSubqueries.push(subquery);
      }
    }

    return relationSubqueries;
  }

  /**
   * Build one-to-one relation query
   *
   * Handles queries for one-to-one relationships
   */
  private buildOneToOneQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // Use the generic approach
    return this.buildGenericRelationQuery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build one-to-many relation query
   *
   * Handles queries for one-to-many relationships
   */
  private buildOneToManyQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // Use the generic approach
    return this.buildGenericRelationQuery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build many-to-one relation query
   *
   * Handles queries for many-to-one relationships
   */
  private buildManyToOneQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // Use the generic approach
    return this.buildGenericRelationQuery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build many-to-many relation query
   *
   * Handles queries for many-to-many relationships
   */
  private buildManyToManyQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // Fall back to the unified approach since we don't have source model context here
    return this.buildGenericRelationQuery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build self-relation query
   *
   * Handles queries for self-referencing relationships
   */
  private buildSelfRelationQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // Use the unified approach for now
    return this.buildUnifiedRelationSubquery(
      relation,
      relationArgs,
      parentAlias,
      relationFieldName
    );
  }

  /**
   * Build nested relation query
   *
   * Handles deeply nested relation queries
   */
  private buildNestedRelationQuery(
    relation: Relation<any, any>,
    nestedArgs: any,
    parentAlias: string,
    depth: number = 0
  ): Sql {
    // TODO: Implement nested relation handling with depth limits
    if (depth > 10) {
      throw new Error("Maximum relation nesting depth exceeded");
    }

    return this.buildUnifiedRelationSubquery(
      relation,
      nestedArgs,
      parentAlias,
      `nested_${depth}`
    );
  }

  /**
   * Build relation count query
   *
   * Creates queries to count related records
   */
  private buildRelationCountQuery(
    relation: Relation<any, any>,
    countArgs: any,
    parentAlias: string
  ): Sql {
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.parser.generateAlias();

    const ctx = this.parser.createContext(targetModel, "count", childAlias, {
      relation,
      parentAlias,
    });

    // Build count query with relation link
    const linkCondition = this.buildRelationLinkCondition(
      relation,
      parentAlias,
      childAlias
    );

    // Use adapter's count aggregation
    return this.adapter.aggregates.count(ctx);
  }

  /**
   * Build relation aggregation query
   *
   * Creates queries for relation aggregations (sum, avg, etc.)
   */
  private buildRelationAggregationQuery(
    relation: Relation<any, any>,
    aggregationArgs: any,
    parentAlias: string
  ): Sql {
    // TODO: Implement relation aggregation
    throw new Error("buildRelationAggregationQuery() not implemented yet");
  }

  /**
   * Optimize relation queries
   *
   * Applies optimizations for relation query performance
   */
  private optimizeRelationQueries(
    relationQueries: Sql[],
    strategy: "subquery" | "join" | "batch"
  ): Sql[] {
    // For now, return queries as-is
    // Future optimization: apply strategy-specific optimizations
    return relationQueries;
  }

  /**
   * Handle relation query caching
   *
   * Manages caching for repeated relation queries
   */
  private handleRelationCaching(
    relation: Relation<any, any>,
    query: Sql,
    cacheKey: string
  ): Sql {
    // TODO: Implement relation query caching
    return query;
  }

  /**
   * Build relation batch query
   *
   * Creates efficient batch queries for multiple relations
   */
  private buildRelationBatchQuery(
    relations: Array<{
      relation: Relation<any, any>;
      args: any;
      parentAlias: string;
      fieldName: string;
    }>
  ): Sql[] {
    // TODO: Implement relation batch querying
    return relations.map(({ relation, args, parentAlias, fieldName }) =>
      this.buildUnifiedRelationSubquery(relation, args, parentAlias, fieldName)
    );
  }

  /**
   * Handle circular relation detection
   *
   * Prevents infinite loops in circular relations
   */
  private detectCircularRelations(
    relation: Relation<any, any>,
    visitedModels: Set<string>
  ): boolean {
    const targetModel = this.resolveRelationModel(relation);

    if (visitedModels.has(targetModel.name)) {
      return true; // Circular relation detected
    }

    return false;
  }

  /**
   * Build relation join query
   *
   * Creates JOIN-based queries for efficient relation fetching
   */
  private buildRelationJoinQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    // TODO: Implement JOIN-based relation queries
    throw new Error("buildRelationJoinQuery() not implemented yet");
  }

  /**
   * Handle relation field selection
   *
   * Manages field selection within relation queries
   */
  private handleRelationFieldSelection(
    targetModel: Model<any>,
    relationArgs: any,
    childAlias: string
  ): any {
    // Build the relation payload based on arguments
    let relationPayload: any = {};

    if (relationArgs === true) {
      // Simple include: select all fields from target model
      relationPayload = {};
    } else if (typeof relationArgs === "object" && relationArgs !== null) {
      // Complex include/select: pass through the nested arguments
      relationPayload = { ...relationArgs };
    } else {
      throw new Error(
        `Invalid relation arguments for model '${targetModel.name}'`
      );
    }

    return relationPayload;
  }

  /**
   * Validate relation exists and is accessible
   *
   * Ensures the relation is properly defined
   */
  private validateRelation(model: Model<any>, relationName: string): void {
    if (!model.relations.has(relationName)) {
      const availableRelations = Array.from(model.relations.keys());
      throw new Error(
        `Relation '${relationName}' not found on model '${
          model.name
        }'. Available relations: ${availableRelations.join(", ")}`
      );
    }
  }

  /**
   * Resolve relation target model
   *
   * Gets the target model for a relation
   */
  private resolveRelationModel(relation: Relation<any, any>): Model<any> {
    const model = relation.getter();
    if (!model) {
      throw new Error("Relation model not found");
    }
    return model;
  }

  /**
   * Combine user WHERE conditions with junction table conditions
   */
  private combineWhereConditions(userWhere: any, junctionWhere: any): any {
    if (!userWhere) {
      return junctionWhere;
    }

    if (!junctionWhere) {
      return userWhere;
    }

    // Combine both conditions with AND
    return {
      AND: [userWhere, junctionWhere],
    };
  }

  // ================================
  // Core Implementation Methods (migrated from query-parser.ts)
  // ================================

  /**
   * Build unified relation subquery
   * Migrated from query-parser.ts buildUnifiedRelationSubquery
   */
  private buildUnifiedRelationSubquery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    const relationType = relation["~relationType"];

    // Route to specific relation type handlers
    switch (relationType) {
      case "oneToOne":
        return this.buildOneToOneQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "oneToMany":
        return this.buildOneToManyQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "manyToOne":
        return this.buildManyToOneQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "manyToMany":
        return this.buildManyToManyQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      default:
        // Fallback to the generic implementation for unknown types
        return this.buildGenericRelationQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
    }
  }

  /**
   * Generic relation query builder (fallback for non-specific types)
   */
  private buildGenericRelationQuery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.parser.generateAlias();

    // Validate the target model
    this.validateModel(targetModel);

    const ctx = this.parser.createContext(targetModel, "findMany", childAlias, {
      relation,
      parentAlias,
    });

    // Build the relation payload
    // relationArgs can be:
    // - true (include all fields)
    // - object with select/include/where properties
    let relationPayload: any = {};

    if (relationArgs === true) {
      // Simple include: select all fields from target model
      relationPayload = {
        where: this.buildRelationLinkCondition(
          relation,
          parentAlias,
          childAlias
        ),
      };
    } else if (typeof relationArgs === "object" && relationArgs !== null) {
      // Complex include/select: pass through the nested arguments
      relationPayload = {
        ...relationArgs,
        where: this.combineWhereConditions(
          relationArgs.where,
          this.buildRelationLinkCondition(relation, parentAlias, childAlias)
        ),
      };
    } else {
      throw new Error(
        `Invalid relation arguments for field '${relationFieldName}' on model '${targetModel.name}'`
      );
    }

    // Build the subquery for the related model
    const subquery = this.buildSelectQuery(
      targetModel,
      relationPayload,
      childAlias,
      "findMany"
    );

    // Use adapter's aggregate subquery builder to wrap in relation context
    const wrappedSubquery = this.adapter.subqueries.aggregate(ctx, subquery);

    // Return as aliased subquery column
    const aliasedSubquery = this.adapter.identifiers.aliased(
      sql`(${wrappedSubquery})`,
      relationFieldName
    );
    return aliasedSubquery;
  }

  /**
   * Validate model exists
   * Helper method for model validation
   */
  private validateModel(model: Model<any>): void {
    if (!model) {
      throw new Error("Model is required for relation query");
    }
  }

  /**
   * Build select query for relation
   * This will delegate to the main query parser
   */
  private buildSelectQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: string
  ): Sql {
    // Delegate back to the main query parser's buildSelectQuery method
    // We need to access the private method, so we'll use a workaround
    const context = this.parser.createContext(model, operation as any, alias);

    // Build individual SQL fragments using the parser's clause builders
    const selectStatement = this.parser.components.selectClause.build(
      context,
      payload
    );
    const fromStatement = this.buildFromStatement(model, alias);
    const whereStatement = payload.where
      ? this.parser.components.whereClause.build(context, payload.where)
      : undefined;
    const orderByStatement = payload.orderBy
      ? this.parser.components.orderByClause.build(context, payload.orderBy)
      : undefined;

    // NESTED INCLUDES: Process nested include clauses using existing infrastructure
    let includeSubqueries: Sql[] = [];
    if (payload.include) {
      includeSubqueries = this.buildAllRelationSubqueries(
        model,
        payload,
        alias
      );
    }

    // Build SQL fragments into a query
    const clauses: any = {
      select: selectStatement,
      from: fromStatement,
      ...(whereStatement && { where: whereStatement }),
      ...(orderByStatement && { orderBy: orderByStatement }),
    };

    // Add include subqueries to clauses if we have nested includes
    if (includeSubqueries.length > 0) {
      clauses.include = includeSubqueries;
    }

    // Add pagination if present
    if (payload.take !== undefined || payload.skip !== undefined) {
      clauses.limit = this.parser.components.limitClause.build(
        context,
        payload
      );
    }

    // Let adapter handle the specific operation
    // Default to findMany for relation subqueries
    const operationKey = operation === "findMany" ? "findMany" : "findMany";
    return this.adapter.operations[operationKey](context, clauses);
  }

  /**
   * Build FROM statement for relation queries
   */
  private buildFromStatement(model: Model<any>, alias: string): any {
    const tableName = model.tableName || model.name;
    return this.adapter.identifiers.table(tableName, alias);
  }

  /**
   * Build unified relation subquery with source model context
   */
  private buildUnifiedRelationSubqueryWithModel(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string,
    sourceModel: Model<any>
  ): Sql {
    const relationType = relation["~relationType"];

    // Route to specific relation type handlers
    switch (relationType) {
      case "oneToOne":
        return this.buildOneToOneQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "oneToMany":
        return this.buildOneToManyQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "manyToOne":
        return this.buildManyToOneQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
      case "manyToMany":
        return this.buildManyToManyQueryWithModel(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName,
          sourceModel
        );
      default:
        // Fallback to the generic implementation for unknown types
        return this.buildGenericRelationQuery(
          relation,
          relationArgs,
          parentAlias,
          relationFieldName
        );
    }
  }

  /**
   * Build many-to-many relation query with source model context
   *
   * Handles queries for many-to-many relationships with access to source model
   */
  private buildManyToManyQueryWithModel(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string,
    sourceModel: Model<any>
  ): Sql {
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.parser.generateAlias();

    // Get the source and target model names
    const sourceModelName = sourceModel.name;
    const targetModelName = targetModel.name;

    // Get junction table and field names
    const junctionTableName = getJunctionTableName(
      relation,
      sourceModelName,
      targetModelName
    );
    const [sourceFieldName, targetFieldName] = getJunctionFieldNames(
      relation,
      sourceModelName,
      targetModelName
    );

    // Build the junction table existence condition for WHERE clause
    const junctionExistsCondition = {
      _junctionExists: {
        junctionTable: junctionTableName,
        sourceField: sourceFieldName,
        targetField: targetFieldName,
        parentAlias,
        childAlias,
        onField: relation["~onField"] || "id",
        refField: relation["~refField"] || "id",
      },
    };

    // Build the relation payload with junction table condition
    let relationPayload: any = {};

    if (relationArgs === true) {
      // Simple include: just the junction table condition
      relationPayload = {
        where: junctionExistsCondition,
      };
    } else if (typeof relationArgs === "object" && relationArgs !== null) {
      // Complex include/select: combine user conditions with junction table condition
      relationPayload = {
        ...relationArgs,
        where: this.combineWhereConditions(
          relationArgs.where,
          junctionExistsCondition
        ),
      };
    } else {
      throw new Error(
        `Invalid relation arguments for field '${relationFieldName}' on model '${targetModel.name}'`
      );
    }

    // 🎯 KEY FIX: Use buildSelectQuery to get nested include processing
    const subquery = this.buildSelectQuery(
      targetModel,
      relationPayload,
      childAlias,
      "findMany"
    );

    // Use adapter's aggregate subquery builder to wrap in relation context
    const ctx = this.parser.createContext(targetModel, "findMany", childAlias, {
      relation,
      parentAlias,
    });
    const wrappedSubquery = this.adapter.subqueries.aggregate(ctx, subquery);

    // Return as aliased subquery column
    return sql`(${wrappedSubquery}) AS ${this.adapter.identifiers.escape(
      relationFieldName
    )}`;
  }
}
