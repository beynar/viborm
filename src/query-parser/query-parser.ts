import { Sql } from "@sql";
import { Model } from "../schema/model";
import { Operation } from "@types";
import { DatabaseAdapter } from "../adapters/database-adapter";
import { BuilderContext } from "./types";
import { sql } from "@sql";

// Component imports
import { ReadOperations } from "./operations/read-operations";
import { UpsertOperations } from "./operations/upsert-operations";
import { AggregateOperations } from "./operations/aggregate-operations";

import { SelectClauseBuilder } from "./clauses/select-clause";
import { WhereClauseBuilder } from "./clauses/where-clause";
import { OrderByClauseBuilder } from "./clauses/orderby-clause";
import { LimitClauseBuilder } from "./clauses/limit-clause";

import { RelationQueryBuilder } from "./relations/relation-queries";
import { RelationFilterBuilder } from "./relations/relation-filters";
import { RelationMutationBuilder } from "./relations/relation-mutations";

import { FieldFilterBuilder } from "./fields/field-filters";
import { FieldUpdateBuilder } from "./fields/field-updates";
import { FieldValidatorBuilder } from "./fields/field-validators";

import { ContextFactory } from "./utils/context-factory";
import { AliasGenerator } from "./utils/alias-generator";
import { QueryValidator } from "./validation/query-validator";

/**
 * QueryParser - Main Coordinator Class
 *
 * This is the central orchestrator for the BaseORM query parsing system. It follows
 * a composition-based architecture where specialized components handle different
 * aspects of query building, rather than having one monolithic class.
 *
 * ARCHITECTURE PRINCIPLES:
 * - Composition over inheritance: Components are injected and coordinated
 * - Single responsibility: Each component handles one specific concern
 * - Database abstraction: All database-specific logic is in adapters
 * - Type safety: Full TypeScript support with proper type inference
 * - Modularity: Components can be tested and developed independently
 *
 * COMPONENT ORGANIZATION:
 * - Operations: Handle different query types (read, mutation, aggregate)
 * - Clauses: Build SQL clauses (SELECT, WHERE, ORDER BY, etc.)
 * - Relations: Handle relation queries, filters, and mutations
 * - Fields: Handle field-specific operations and validations
 * - Utils: Shared utilities (context creation, alias generation)
 *
 * FLOW:
 * 1. Static parse() method receives operation, model, payload, adapter
 * 2. Creates QueryParser instance with all components
 * 3. Routes to appropriate operation handler based on operation type
 * 4. Operation handler coordinates with clause builders and other components
 * 5. Returns final SQL statement through adapter
 *
 * EXTENSIBILITY:
 * - New operations: Add to operations/ directory
 * - New field types: Extend field handlers
 * - New databases: Implement adapter interface
 * - New features: Add appropriate component
 *
 * PERFORMANCE CONSIDERATIONS:
 * - Components are created once per parser instance
 * - Alias generation is centralized and efficient
 * - Context creation is optimized through factory pattern
 * - SQL building uses efficient template literal system
 */
export class QueryParser {
  // Core utilities
  private aliasGenerator: AliasGenerator;
  private contextFactory: ContextFactory;
  private validator: QueryValidator;

  // Operation handlers
  private readOperations: ReadOperations;
  private upsertOperations: UpsertOperations;
  private aggregateOperations: AggregateOperations;

  // Clause builders
  private selectClause: SelectClauseBuilder;
  private whereClause: WhereClauseBuilder;
  private orderByClause: OrderByClauseBuilder;
  private limitClause: LimitClauseBuilder;

  // Relation handlers
  private relationQueries: RelationQueryBuilder;
  private relationFilters: RelationFilterBuilder;
  private relationMutations: RelationMutationBuilder;

  // Field handlers
  private fieldFilters: FieldFilterBuilder;
  private fieldUpdates: FieldUpdateBuilder;
  private fieldValidators: FieldValidatorBuilder;

  constructor(private adapter: DatabaseAdapter) {
    // Initialize utilities first (other components depend on these)
    this.aliasGenerator = new AliasGenerator();
    this.contextFactory = new ContextFactory(this);
    this.validator = new QueryValidator(this);

    // Initialize clause builders
    this.selectClause = new SelectClauseBuilder(this, adapter);
    this.whereClause = new WhereClauseBuilder(this, adapter);
    this.orderByClause = new OrderByClauseBuilder(this, adapter);
    this.limitClause = new LimitClauseBuilder(this, adapter);

    // Initialize field handlers
    this.fieldFilters = new FieldFilterBuilder(this, adapter);
    this.fieldUpdates = new FieldUpdateBuilder(this, adapter);
    this.fieldValidators = new FieldValidatorBuilder(this, adapter);

    // Initialize relation handlers
    this.relationQueries = new RelationQueryBuilder(this, adapter);
    this.relationFilters = new RelationFilterBuilder(this, adapter);
    this.relationMutations = new RelationMutationBuilder(this, adapter);

    // Initialize operation handlers (these coordinate other components)
    this.readOperations = new ReadOperations(this, adapter);
    this.upsertOperations = new UpsertOperations(this, adapter);
    this.aggregateOperations = new AggregateOperations(this, adapter);
  }

  /**
   * Main entry point for query parsing
   *
   * This static method provides a clean API for external consumers while
   * managing the lifecycle of the QueryParser instance internally.
   */
  static parse(
    operation: Operation,
    model: Model<any>,
    payload: any,
    adapter: DatabaseAdapter
  ): Sql {
    const parser = new QueryParser(adapter);
    return parser.buildQuery(operation, model, payload);
  }

  /**
   * Internal query building method that routes to appropriate operation handler
   */
  private buildQuery(
    operation: Operation,
    model: Model<any>,
    payload: any
  ): Sql {
    // Step 1: Skip validation for now - can be added later
    // TODO: Implement validation once QueryValidator is complete

    // Step 2: Generate alias and create context
    const alias = this.aliasGenerator.generate();
    const context = this.contextFactory.createFromPayload(
      model,
      operation,
      alias,
      payload
    );

    // Step 3: Route to appropriate operation handler based on operation type
    let sql: Sql;

    if (this.isReadOperation(operation)) {
      sql = this.buildSelectQuery(model, payload, alias, operation);
    } else if (this.isMutationOperation(operation)) {
      sql = this.buildMutationQuery(model, payload, alias, operation);
    } else if (this.isUpsertOperation(operation)) {
      sql = this.upsertOperations.handle(model, payload);
    } else if (this.isAggregateOperation(operation)) {
      sql = this.buildAggregateQuery(model, payload, alias, operation);
    } else if (operation === "exist") {
      sql = this.buildExistQuery(model, payload, alias, context);
    } else {
      throw new Error(`Unsupported operation: ${operation}`);
    }

    return sql;
  }

  /**
   * Build SELECT query - Enhanced with operation-specific logic
   */
  private buildSelectQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): Sql {
    const context = this.contextFactory.createFromPayload(
      model,
      operation,
      alias,
      payload
    );

    // Build individual SQL fragments using the new clause builders
    const selectStatement = this.selectClause.build(context, payload);
    const fromStatement = this.buildFromStatement(model, alias);
    const whereStatement = payload.where
      ? this.whereClause.build(context, payload.where)
      : undefined;
    const orderByStatement = payload.orderBy
      ? this.orderByClause.build(context, payload.orderBy)
      : undefined;

    // Handle relations using the relation query builder
    const relationSubqueries = this.relationQueries.buildAllRelationSubqueries(
      model,
      payload,
      alias
    );

    // Use adapter to build final query with proper clause syntax
    const clauses: any = {
      select: selectStatement,
      from: fromStatement,
      ...(whereStatement &&
        !this.isEmptyWhereClause(whereStatement) && { where: whereStatement }),
      ...(orderByStatement && { orderBy: orderByStatement }),
      ...(relationSubqueries.length > 0 && { include: relationSubqueries }),
    };

    // Handle operation-specific logic
    switch (operation) {
      case "findUnique":
      case "findUniqueOrThrow":
        // Validate that WHERE clause targets unique fields
        this.validateUniqueWhere(model, payload.where);
        // Always limit to 1 for unique operations
        clauses.limit = this.adapter.builders.limit(context, sql`1`);
        break;

      case "findFirst":
      case "findFirstOrThrow":
        // Always limit to 1 for first operations
        clauses.limit = this.adapter.builders.limit(context, sql`1`);
        break;

      case "findMany":
        // Handle distinct if present
        if (payload.distinct) {
          clauses.distinct = this.buildDistinctClause(payload.distinct, alias);
        }

        // Handle pagination (take, skip, cursor)
        if (
          payload.take !== undefined ||
          payload.skip !== undefined ||
          payload.cursor
        ) {
          clauses.limit = this.limitClause.build(context, payload);
        }
        break;
    }

    // Let adapter handle the specific operation
    return this.adapter.operations[operation](context, clauses);
  }

  /**
   * Build FROM statement - temporary implementation
   */
  private buildFromStatement(model: Model<any>, alias: string): any {
    const tableName = model.tableName || model.name;
    return this.adapter.identifiers.table(tableName, alias);
  }

  // Helper methods to categorize operations
  private isReadOperation(operation: Operation): boolean {
    return [
      "findMany",
      "findFirst",
      "findUnique",
      "findUniqueOrThrow",
      "findFirstOrThrow",
    ].includes(operation);
  }

  private isMutationOperation(operation: Operation): boolean {
    return [
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
    ].includes(operation);
  }

  private isUpsertOperation(operation: Operation): boolean {
    return operation === "upsert";
  }

  private isAggregateOperation(operation: Operation): boolean {
    return ["count", "aggregate", "groupBy"].includes(operation);
  }

  // Helper method to resolve relation models (needed for validation)
  private resolveRelationModel(relation: any): Model<any> {
    const model = relation.getter();
    if (!model) {
      throw new Error("Relation model could not be resolved");
    }
    return model;
  }

  /**
   * Validate that WHERE clause targets unique fields
   */
  private validateUniqueWhere(model: Model<any>, where: any): void {
    if (!where) {
      throw new Error(
        `WHERE clause is required for unique operations on model '${model.name}'`
      );
    }

    // For now, we'll do basic validation - ensure at least one field is present
    // In a full implementation, we'd check if the fields constitute a unique constraint
    const fieldNames = Object.keys(where);
    if (fieldNames.length === 0) {
      throw new Error(
        `WHERE clause must specify at least one field for unique operations on model '${model.name}'`
      );
    }

    // TODO: In future, validate that the fields actually form a unique constraint
    // This would require schema introspection of unique indexes/constraints
  }

  /**
   * Build DISTINCT clause for specified fields
   */
  private buildDistinctClause(distinct: string[], alias: string): Sql {
    // Validate that all distinct fields exist on the model
    const distinctFields = distinct.map((field) => {
      return this.adapter.identifiers.column(alias, field);
    });

    return sql.join(distinctFields, ", ");
  }

  /**
   * Process data for CREATE operations - validate and transform
   */
  private processCreateData(model: Model<any>, data: any): Record<string, any> {
    if (!data || typeof data !== "object") {
      throw new Error(
        `CREATE data must be an object for model '${model.name}'`
      );
    }

    // For now, basic processing - just pass through the data
    // In the future, this would handle:
    // - Field validation
    // - Type coercion
    // - Default value application
    // - Relation handling (connect, create, etc.)

    return { ...data };
  }

  /**
   * Process data for UPDATE operations - validate and transform
   *
   * Now leverages FieldUpdateBuilder for early validation of field types
   * and update operations to catch errors before SQL generation.
   */
  private processUpdateData(model: Model<any>, data: any): Record<string, any> {
    if (!data || typeof data !== "object") {
      throw new Error(
        `UPDATE data must be an object for model '${model.name}'`
      );
    }

    // Validate each field and its update value against FieldUpdateBuilder
    const processedData: Record<string, any> = {};

    for (const [fieldName, updateValue] of Object.entries(data)) {
      // Check if field exists on the model
      const field = model.fields.get(fieldName);
      if (!field) {
        const availableFields = Array.from(model.fields.keys());
        throw new Error(
          `Field '${fieldName}' not found on model '${
            model.name
          }'. Available fields: ${availableFields.join(", ")}`
        );
      }

      const fieldType = field["~fieldType"];
      if (!fieldType) {
        throw new Error(
          `Field type missing for '${fieldName}' in model '${model.name}'`
        );
      }

      // Validate that the field type is supported for updates
      if (!this.fieldUpdates.canHandle(fieldType)) {
        throw new Error(
          `Field type '${fieldType}' is not supported for updates on field '${fieldName}' in model '${model.name}'`
        );
      }

      // Let Zod handle all validation and transformation through the field update builder
      // No need for manual value categorization - Zod knows how to handle both raw values and operation objects

      // If all validations pass, include the value in processed data
      processedData[fieldName] = updateValue;
    }

    return processedData;
  }

  /**
   * Build SET clause for UPDATE operations
   */
  private buildSetClause(data: Record<string, any>, model: Model<any>): Sql {
    const setParts = Object.entries(data).map(([fieldName, value]) => {
      const columnId = this.adapter.identifiers.escape(fieldName);

      // Create context for operators
      const ctx = {
        model,
        baseOperation: "update" as any,
        alias: "temp",
        fieldName,
      } as any;

      // Process the update value through field update handlers
      const field = model.fields.get(fieldName);
      if (field) {
        const updateCtx = this.contextFactory.create(model, "update", "temp", {
          field: field as any,
          fieldName,
        });
        const updateExpression = this.fieldUpdates.handle(
          updateCtx,
          value,
          fieldName
        );

        // Use adapter operators for equality
        return this.adapter.operators.eq(ctx, columnId, updateExpression);
      }

      // Fallback for fields without handlers
      return this.adapter.operators.eq(ctx, columnId, sql`${value}`);
    });

    return sql.join(setParts, ", ");
  }

  /**
   * Build MUTATION query - Handle create, update, delete operations with CTE wrapper
   */
  private buildMutationQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): Sql {
    const context = this.contextFactory.createFromPayload(
      model,
      operation,
      alias,
      payload
    );

    // Build the core mutation query (without CTE wrapper)
    let mutationQuery: Sql;

    switch (operation) {
      case "create":
        mutationQuery = this.buildCoreCreateQuery(model, payload, context);
        break;
      case "createMany":
        mutationQuery = this.buildCoreCreateManyQuery(model, payload, context);
        break;
      case "update":
        mutationQuery = this.buildCoreUpdateQuery(model, payload, context);
        break;
      case "updateMany":
        mutationQuery = this.buildCoreUpdateManyQuery(model, payload, context);
        break;
      case "delete":
        mutationQuery = this.buildCoreDeleteQuery(model, payload, context);
        break;
      case "deleteMany":
        mutationQuery = this.buildCoreDeleteManyQuery(model, payload, context);
        break;
      default:
        throw new Error(`Unsupported mutation operation: ${operation}`);
    }

    // Wrap mutation in CTE and build SELECT from it
    return this.buildMutationWithCTE(
      model,
      payload,
      alias,
      mutationQuery,
      context
    );
  }

  /**
   * Build mutation query wrapped in CTE with SELECT
   */
  private buildMutationWithCTE(
    model: Model<any>,
    payload: any,
    alias: string,
    mutationQuery: Sql,
    context: BuilderContext
  ): Sql {
    // Build CTE wrapper
    const withClause = this.adapter.cte.build([
      { alias, query: mutationQuery },
    ]);

    // Build SELECT clause from CTE
    const selectStatement = this.selectClause.build(context, payload);
    const fromStatement = this.adapter.identifiers.escape(alias);

    // Handle relations using the relation query builder if needed
    const relationSubqueries = payload.include
      ? this.relationQueries.buildAllRelationSubqueries(model, payload, alias)
      : [];

    // Build final query: WITH ... SELECT ... FROM cte
    const selectFromCTE = sql`SELECT ${selectStatement} FROM ${fromStatement}`;

    return sql`${withClause} ${selectFromCTE}`;
  }

  /**
   * Build CREATE query - Insert single record
   */
  private buildCoreCreateQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    if (!payload.data) {
      throw new Error(
        `CREATE operation requires 'data' field for model '${model.name}'`
      );
    }

    // Process and validate data
    const processedData = this.processCreateData(model, payload.data);

    // For create operations, pass payload directly to adapter
    const createPayload = {
      data: processedData,
      select: payload.select,
    };

    return this.adapter.operations.create(context, createPayload);
  }

  /**
   * Build CREATE MANY query - Insert multiple records
   */
  private buildCoreCreateManyQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    if (!payload.data || !Array.isArray(payload.data)) {
      throw new Error(
        `CREATE_MANY operation requires 'data' array for model '${model.name}'`
      );
    }

    // Process each record
    const processedRecords = payload.data.map((record: any) =>
      this.processCreateData(model, record)
    );

    // For createMany operations, pass payload directly to adapter
    const createManyPayload = {
      data: processedRecords,
      select: payload.select,
    };

    return this.adapter.operations.createMany(context, createManyPayload);
  }

  /**
   * Build UPDATE query - Update single record (requires unique WHERE)
   */
  private buildCoreUpdateQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    if (!payload.data) {
      throw new Error(
        `UPDATE operation requires 'data' field for model '${model.name}'`
      );
    }

    // Validate unique WHERE clause (Prisma requires this for single updates)
    this.validateUniqueWhere(model, payload.where);

    // Process update data
    const processedData = this.processUpdateData(model, payload.data);

    // Build clauses structure for adapter
    const clauses: any = {
      select: payload.select
        ? this.selectClause.build(context, payload)
        : undefined,
      from: this.buildFromStatement(model, context.alias),
      where: payload.where
        ? this.buildMutationWhereClause(model, payload.where)
        : undefined,
      set: this.buildSetClause(processedData, model),
    };

    return this.adapter.operations.update(context, clauses);
  }

  /**
   * Build UPDATE MANY query - Update multiple records
   */
  private buildCoreUpdateManyQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    if (!payload.data) {
      throw new Error(
        `UPDATE_MANY operation requires 'data' field for model '${model.name}'`
      );
    }

    // Process update data
    const processedData = this.processUpdateData(model, payload.data);

    // Build clauses structure for adapter
    const clauses: any = {
      select: payload.select
        ? this.selectClause.build(context, payload)
        : undefined,
      from: this.buildFromStatement(model, context.alias),
      where: payload.where
        ? this.buildMutationWhereClause(model, payload.where)
        : undefined,
      set: this.buildSetClause(processedData, model),
    };

    return this.adapter.operations.updateMany(context, clauses);
  }

  /**
   * Build DELETE query - Delete single record (requires unique WHERE)
   */
  private buildCoreDeleteQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    // Validate unique WHERE clause (Prisma requires this for single deletes)
    this.validateUniqueWhere(model, payload.where);

    // Build clauses structure for adapter
    const clauses: any = {
      select: payload.select
        ? this.selectClause.build(context, payload)
        : undefined,
      from: this.buildFromStatement(model, context.alias),
      where: this.buildMutationWhereClause(model, payload.where),
    };

    return this.adapter.operations.delete(context, clauses);
  }

  /**
   * Build DELETE MANY query - Delete multiple records
   */
  private buildCoreDeleteManyQuery(
    model: Model<any>,
    payload: any,
    context: BuilderContext
  ): Sql {
    // Build clauses structure for adapter
    const clauses: any = {
      select: payload.select
        ? this.selectClause.build(context, payload)
        : undefined,
      from: this.buildFromStatement(model, context.alias),
      where: payload.where
        ? this.buildMutationWhereClause(model, payload.where)
        : undefined,
    };

    return this.adapter.operations.deleteMany(context, clauses);
  }

  /**
   * Build WHERE clause for mutation operations (UPDATE/DELETE)
   * Uses bare column names without table qualifiers since mutations don't use table aliases
   */
  private buildMutationWhereClause(model: Model<any>, where: any): Sql {
    if (!where) {
      return sql.empty;
    }

    // For mutations, build WHERE conditions without table aliases
    return this.buildMutationWhereConditions(model, where);
  }

  /**
   * Build WHERE conditions for mutations without table aliases
   */
  private buildMutationWhereConditions(model: Model<any>, where: any): Sql {
    const conditions: Sql[] = [];

    for (const [key, value] of Object.entries(where)) {
      if (key === "AND") {
        const andConditions = (value as any[]).map((condition: any) =>
          this.buildMutationWhereConditions(model, condition)
        );
        // Create minimal context for operators
        const ctx = {
          model,
          baseOperation: "update" as any,
          alias: "temp",
        } as any;
        conditions.push(this.adapter.operators.and(ctx, ...andConditions));
      } else if (key === "OR") {
        const orConditions = (value as any[]).map((condition: any) =>
          this.buildMutationWhereConditions(model, condition)
        );
        // Create minimal context for operators
        const ctx = {
          model,
          baseOperation: "update" as any,
          alias: "temp",
        } as any;
        conditions.push(this.adapter.operators.or(ctx, ...orConditions));
      } else if (key === "NOT") {
        const notCondition = this.buildMutationWhereConditions(model, value);
        // Create minimal context for operators
        const ctx = {
          model,
          baseOperation: "update" as any,
          alias: "temp",
        } as any;
        conditions.push(this.adapter.operators.not(ctx, notCondition));
      } else {
        // Handle field conditions
        const fieldCondition = this.buildMutationFieldCondition(
          model,
          key,
          value
        );
        conditions.push(fieldCondition);
      }
    }

    if (conditions.length === 0) {
      return sql.empty;
    }

    if (conditions.length === 1) {
      if (conditions[0] === undefined) {
        return sql.empty;
      }
      return conditions[0];
    }

    // Create minimal context for final AND combination
    const ctx = { model, baseOperation: "update" as any, alias: "temp" } as any;
    return this.adapter.operators.and(ctx, ...conditions);
  }

  /**
   * Build field condition for mutations without table aliases
   */
  private buildMutationFieldCondition(
    model: Model<any>,
    fieldName: string,
    condition: any
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

    // Create a context with a dummy alias for mutations
    const ctx = this.contextFactory.create(model, "update", "mutation", {
      field: field as any,
      fieldName,
    });

    // Temporarily override the column identifier to use bare column names
    const originalColumn = this.adapter.identifiers.column;
    this.adapter.identifiers.column = (alias: string, field: string) =>
      this.adapter.identifiers.escape(field);

    try {
      // Handle simple equality
      if (
        typeof condition === "string" ||
        typeof condition === "number" ||
        typeof condition === "boolean" ||
        condition === null
      ) {
        return this.fieldFilters.handle(ctx, { equals: condition }, fieldName);
      }

      // Handle complex filters - delegate to FieldFilterBuilder
      return this.fieldFilters.handle(ctx, condition, fieldName);
    } finally {
      // Restore original column identifier
      this.adapter.identifiers.column = originalColumn;
    }
  }

  /**
   * Build AGGREGATE query - Handle count, aggregate, and groupBy operations
   */
  private buildAggregateQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): Sql {
    const context = this.contextFactory.createFromPayload(
      model,
      operation,
      alias,
      payload
    );

    switch (operation) {
      case "count":
        return this.buildCountQuery(model, payload, alias, context);
      case "aggregate":
        return this.buildAggregateQueryImpl(model, payload, alias, context);
      case "groupBy":
        return this.buildGroupByQuery(model, payload, alias, context);
      default:
        throw new Error(`Unsupported aggregate operation: ${operation}`);
    }
  }

  /**
   * Build COUNT query - Count records with optional filtering
   */
  private buildCountQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    context: BuilderContext
  ): Sql {
    // Build SELECT clause for count operation
    const selectStatement = this.selectClause.build(context, payload);

    // Build clauses structure for adapter
    const clauses: any = {
      select: selectStatement,
      from: this.buildFromStatement(model, alias),
      where: payload.where
        ? this.whereClause.build(context, payload.where)
        : undefined,
      orderBy: payload.orderBy
        ? this.orderByClause.build(context, payload.orderBy)
        : undefined,
    };

    return this.adapter.operations.count(context, clauses);
  }

  /**
   * Build AGGREGATE query - Perform aggregation operations (sum, avg, min, max, count)
   */
  private buildAggregateQueryImpl(
    model: Model<any>,
    payload: any,
    alias: string,
    context: BuilderContext
  ): Sql {
    // Build SELECT clause with aggregations
    const selectStatement = this.selectClause.build(context, payload);

    // Build clauses structure for adapter
    const clauses: any = {
      select: selectStatement,
      from: this.buildFromStatement(model, alias),
      where: payload.where
        ? this.whereClause.build(context, payload.where)
        : undefined,
      orderBy: payload.orderBy
        ? this.orderByClause.build(context, payload.orderBy)
        : undefined,
    };

    return this.adapter.operations.aggregate(context, clauses);
  }

  /**
   * Build GROUP BY query - Group records and apply aggregations
   */
  private buildGroupByQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    context: BuilderContext
  ): Sql {
    // Build SELECT clause for groupBy operation (includes grouping fields and aggregations)
    const selectStatement = this.selectClause.build(context, payload);

    // Build GROUP BY clause from the 'by' field
    const groupByFields = payload.by;
    if (
      !groupByFields ||
      !Array.isArray(groupByFields) ||
      groupByFields.length === 0
    ) {
      throw new Error(
        `GROUP BY operation requires 'by' field with array of field names for model '${model.name}'`
      );
    }

    // Build GROUP BY statement
    const groupByColumns = groupByFields.map((field: string) =>
      this.adapter.identifiers.column(alias, field)
    );
    const groupByStatement = this.adapter.builders.groupBy(
      context,
      sql.join(groupByColumns, ", ")
    );

    // Build HAVING clause if present
    const havingStatement = payload.having
      ? this.buildHavingClause(model, payload.having, alias, context)
      : undefined;

    // Build clauses structure for adapter
    const clauses: any = {
      select: selectStatement,
      from: this.buildFromStatement(model, alias),
      where: payload.where
        ? this.whereClause.build(context, payload.where)
        : undefined,
      groupBy: groupByStatement,
      having: havingStatement,
      orderBy: payload.orderBy
        ? this.orderByClause.build(context, payload.orderBy)
        : undefined,
    };

    return this.adapter.operations.groupBy(context, clauses);
  }

  /**
   * Build HAVING clause for GROUP BY operations
   */
  private buildHavingClause(
    model: Model<any>,
    having: any,
    alias: string,
    context: BuilderContext
  ): Sql {
    // For now, we'll use the WHERE clause builder to handle HAVING conditions
    // In a full implementation, we'd have a dedicated HAVING clause builder
    // that understands aggregate functions in conditions
    const havingConditions = this.whereClause.build(context, having);
    return this.adapter.builders.having(context, havingConditions);
  }

  // Public accessors for components (used by other components)
  public get components() {
    return {
      aliasGenerator: this.aliasGenerator,
      contextFactory: this.contextFactory,
      validator: this.validator,
      selectClause: this.selectClause,
      whereClause: this.whereClause,
      orderByClause: this.orderByClause,
      limitClause: this.limitClause,
      relationQueries: this.relationQueries,
      relationFilters: this.relationFilters,
      relationMutations: this.relationMutations,
      fieldFilters: this.fieldFilters,
      fieldUpdates: this.fieldUpdates,
      fieldValidators: this.fieldValidators,
    };
  }

  // Convenience methods for common operations (used by components)
  public generateAlias(): string {
    return this.aliasGenerator.generate();
  }

  public createContext(
    model: Model<any>,
    operation: Operation,
    alias: string,
    options: any = {}
  ): BuilderContext {
    return this.contextFactory.create(model, operation, alias, options);
  }

  // Helper method to check if a WHERE clause is truly empty
  private isEmptyWhereClause(where: Sql): boolean {
    return where === sql.empty || where.toStatement().trim() === "";
  }

  /**
   * Build EXIST query using database adapter
   */
  private buildExistQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    context: BuilderContext
  ): Sql {
    // Build individual SQL fragments using the clause builders (same as other operations)
    const selectStatement = sql`1`; // For EXISTS, we only need to check existence
    const fromStatement = this.buildFromStatement(model, alias);
    const whereStatement = payload.where
      ? this.whereClause.build(context, payload.where)
      : undefined;

    // Build clauses object following the same pattern as other operations
    const clauses: any = {
      select: selectStatement,
      from: fromStatement,
      ...(whereStatement &&
        !this.isEmptyWhereClause(whereStatement) && { where: whereStatement }),
      limit: this.adapter.builders.limit(context, sql`1`), // Always add LIMIT 1 for performance
    };

    // Let adapter handle the specific operation (same pattern as other operations)
    return this.adapter.operations.exist(context, clauses);
  }
}
