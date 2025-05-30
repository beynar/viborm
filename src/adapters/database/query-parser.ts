import { Sql, sql } from "../../sql/sql";
import { Model } from "../../schema/model";
import { Operation } from "../../types/client/operations/defintion";
import { Field, Relation } from "../../schema";
import { DatabaseAdapter, QueryClauses } from "./database-adapter";

// ================================
// Error Classes
// ================================

export class QueryParserError extends Error {
  constructor(
    message: string,
    public context?: {
      operation?: Operation;
      model?: string;
      field?: string;
      relation?: string;
      payload?: any;
    }
  ) {
    super(message);
    this.name = "QueryParserError";
  }
}

export class ValidationError extends QueryParserError {
  constructor(message: string, context?: QueryParserError["context"]) {
    super(message, context);
    this.name = "ValidationError";
  }
}

// ================================
// Core Types
// ================================

export type BuilderContext = {
  sql?: Sql;
  model: Model<any>;
  field?: Field<any>;
  relation?: Relation<any, any>;
  baseOperation: Operation;
  alias: string;
  parentAlias?: string; // For relation contexts
  fieldName?: string; // For field filters
};

// ================================
// Generic Filter Handler Type
// ================================
type FilterHandler<T = any> = (ctx: BuilderContext, value: T) => Sql;

// ================================
// Recursive Query Builder
// ================================

class QueryParser {
  private aliasCounter = 0;

  constructor(private adapter: DatabaseAdapter) {}

  // ================================
  // Validation Methods
  // ================================

  private validateOperation(operation: Operation): void {
    const validOperations: Operation[] = [
      "findMany",
      "findFirst",
      "findUnique",
      "findUniqueOrThrow",
      "findFirstOrThrow",
      "create",
      "createMany",
      "update",
      "updateMany",
      "delete",
      "deleteMany",
      "upsert",
      "count",
      "aggregate",
      "groupBy",
    ];

    if (!validOperations.includes(operation)) {
      throw new ValidationError(`Invalid operation: ${operation}`, {
        operation,
      });
    }
  }

  private validateModel(model: Model<any>): void {
    if (!model) {
      throw new ValidationError("Model is required");
    }

    if (!model.name) {
      throw new ValidationError("Model must have a name", {
        model: model.name,
      });
    }

    if (!model.fields || model.fields.size === 0) {
      throw new ValidationError(`Model '${model.name}' has no fields`, {
        model: model.name,
      });
    }
  }

  private validateField(model: Model<any>, fieldName: string): void {
    if (!model.fields.has(fieldName)) {
      const availableFields = Array.from(model.fields.keys()).join(", ");
      throw new ValidationError(
        `Field '${fieldName}' not found on model '${model.name}'. Available fields: ${availableFields}`,
        { model: model.name, field: fieldName }
      );
    }
  }

  private validateRelation(model: Model<any>, relationName: string): void {
    if (!model.relations.has(relationName)) {
      const availableRelations = Array.from(model.relations.keys()).join(", ");
      throw new ValidationError(
        `Relation '${relationName}' not found on model '${model.name}'. Available relations: ${availableRelations}`,
        { model: model.name, relation: relationName }
      );
    }
  }

  private validatePayload(operation: Operation, payload: any): void {
    if (!payload || typeof payload !== "object") {
      throw new ValidationError(
        `Payload is required for operation '${operation}'`,
        { operation, payload }
      );
    }

    // Validate operation-specific requirements
    switch (operation) {
      case "create":
      case "createMany":
      case "update":
      case "updateMany":
      case "upsert":
        if (!payload.data) {
          throw new ValidationError(
            `Operation '${operation}' requires 'data' field`,
            { operation, payload }
          );
        }
        break;

      case "findUnique":
      case "findUniqueOrThrow":
        if (!payload.where) {
          throw new ValidationError(
            `Operation '${operation}' requires 'where' field`,
            { operation, payload }
          );
        }
        break;
    }

    // Validate createMany data is array
    if (operation === "createMany" && !Array.isArray(payload.data)) {
      throw new ValidationError(
        "createMany operation requires 'data' to be an array",
        { operation, payload }
      );
    }
  }

  private validateSelectFields(model: Model<any>, select: any): void {
    if (!select || typeof select !== "object") return;

    for (const [fieldName, value] of Object.entries(select)) {
      if (model.fields.has(fieldName)) {
        // Scalar field - value should be true
        if (value !== true) {
          throw new ValidationError(
            `Scalar field '${fieldName}' in select must have value 'true'`,
            { model: model.name, field: fieldName }
          );
        }
      } else if (model.relations.has(fieldName)) {
        // Relation field - value can be true or object with nested select
        if (value === true) {
          // Simple relation selection - valid
          continue;
        } else if (typeof value === "object" && value !== null) {
          // Nested relation selection - validate recursively
          const relation = model.relations.get(fieldName)!;
          const targetModel = this.resolveRelationModel(relation);
          const relationValue = value as any; // Cast to any to access nested properties

          // Validate nested select if present
          if (relationValue.select) {
            this.validateSelectFields(targetModel, relationValue.select);
          }

          // Validate nested include if present (relations can have both select and include)
          if (relationValue.include) {
            this.validateIncludeFields(targetModel, relationValue.include);
          }

          // Validate nested where if present (relations can have where clauses)
          if (relationValue.where) {
            // We could add where validation here, but it would be complex
            // For now, we'll let the where validation happen in buildWhereStatement
          }
        } else {
          throw new ValidationError(
            `Relation '${fieldName}' in select must be 'true' or an object with select/include properties`,
            { model: model.name, relation: fieldName }
          );
        }
      } else {
        // Field/relation not found
        const availableFields = Array.from(model.fields.keys());
        const availableRelations = Array.from(model.relations.keys());
        const available = [...availableFields, ...availableRelations].join(
          ", "
        );

        throw new ValidationError(
          `Field or relation '${fieldName}' not found on model '${model.name}' in select clause. Available: ${available}`,
          { model: model.name, field: fieldName }
        );
      }
    }
  }

  private validateIncludeFields(model: Model<any>, include: any): void {
    if (!include || typeof include !== "object") return;

    for (const relationName of Object.keys(include)) {
      this.validateRelation(model, relationName);
    }
  }

  // ================================
  // Main Entry Points
  // ================================

  static parse(
    operation: Operation,
    model: Model<any>,
    payload: any,
    adapter: DatabaseAdapter
  ): Sql {
    const parser = new QueryParser(adapter);

    try {
      // Validate inputs
      parser.validateOperation(operation);
      parser.validateModel(model);
      parser.validatePayload(operation, payload);

      // Additional validations for read operations
      if (
        [
          "findMany",
          "findFirst",
          "findUnique",
          "findUniqueOrThrow",
          "findFirstOrThrow",
        ].includes(operation)
      ) {
        if (payload.select) {
          parser.validateSelectFields(model, payload.select);
        }
        if (payload.include) {
          parser.validateIncludeFields(model, payload.include);
        }
      }

      return parser.traverse(operation, model, payload);
    } catch (error) {
      if (error instanceof QueryParserError) {
        throw error;
      }

      // Wrap unexpected errors
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Unexpected error during query parsing: ${errorMessage}`,
        { operation, model: model.name, payload }
      );
    }
  }

  private traverse(operation: Operation, model: Model<any>, payload: any): Sql {
    const alias = this.generateAlias();

    // Build the query based on operation type
    return this.traversePayload(model, payload, operation, alias);
  }

  // ================================
  // Core Traversal Methods
  // ================================

  private traversePayload(
    model: Model<any>,
    payload: any,
    operation: Operation,
    alias: string
  ): Sql {
    // Handle different payload structures based on operation
    switch (operation) {
      case "findMany":
      case "findFirst":
      case "findUnique":
      case "findUniqueOrThrow":
      case "findFirstOrThrow":
        return this.buildSelectQuery(model, payload, alias, operation);

      case "count":
        return this.buildCountQuery(model, payload, alias);

      case "aggregate":
        return this.buildAggregateQuery(model, payload, alias);

      case "groupBy":
        return this.buildGroupByQuery(model, payload, alias);

      case "create":
        return this.buildCreateQuery(model, payload, alias);

      case "createMany":
        return this.buildCreateManyQuery(model, payload, alias);

      case "update":
        return this.buildUpdateQuery(model, payload, alias);

      case "updateMany":
        return this.buildUpdateManyQuery(model, payload, alias);

      case "delete":
        return this.buildDeleteQuery(model, payload, alias);

      case "deleteMany":
        return this.buildDeleteManyQuery(model, payload, alias);

      case "upsert":
        return this.buildUpsertQuery(model, payload, alias);

      default:
        throw new Error(`Unsupported operation: ${operation}`);
    }
  }

  // ================================
  // Query Building Methods
  // ================================

  private buildSelectQuery(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: operation,
      alias,
    };

    try {
      // Determine parent field selection behavior
      const hasExplicitSelect = payload.select !== undefined;
      const parentFieldSelection = hasExplicitSelect ? payload.select : null; // null means select all fields

      // Build individual SQL fragments
      const selectStatement = this.buildSelectStatement(
        model,
        parentFieldSelection,
        alias
      );
      const fromStatement = this.buildFromStatement(model, alias);
      const whereStatement = payload.where
        ? this.buildWhereStatement(model, payload.where, alias)
        : sql.empty;
      const orderByStatement = payload.orderBy
        ? this.buildOrderByStatement(model, payload.orderBy, alias)
        : sql.empty;
      const limitStatement =
        payload.take || payload.skip
          ? this.buildLimitStatement(payload.take, payload.skip)
          : sql.empty;

      // Handle both select relations and include relations using unified approach
      const relationSubqueries = this.buildAllRelationSubqueries(
        model,
        payload,
        alias
      );

      // Use builders to wrap statements in proper clause syntax
      const selectClause = this.adapter.builders.select(ctx, selectStatement);
      const fromClause = this.adapter.builders.from(ctx, fromStatement);
      const whereClause =
        whereStatement !== sql.empty
          ? this.adapter.builders.where(ctx, whereStatement)
          : sql.empty;
      const orderByClause =
        orderByStatement !== sql.empty
          ? this.adapter.builders.orderBy(ctx, orderByStatement)
          : sql.empty;
      const limitClause =
        limitStatement !== sql.empty
          ? this.adapter.builders.limit(ctx, limitStatement)
          : sql.empty;

      const clauses: QueryClauses = {
        select: selectClause,
        from: fromClause,
        ...(whereClause !== sql.empty && { where: whereClause }),
        ...(orderByClause !== sql.empty && { orderBy: orderByClause }),
        ...(limitClause !== sql.empty && { limit: limitClause }),
        ...(relationSubqueries.length > 0 && { include: relationSubqueries }),
      };

      // Use adapter operation to compose final query
      return this.adapter.operations[operation](ctx, clauses);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build select query: ${errorMessage}`,
        { operation, model: model.name, payload }
      );
    }
  }

  private buildCountQuery(model: Model<any>, payload: any, alias: string): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "count",
      alias,
    };

    // Count queries typically only need WHERE clause
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    const fromStatement = this.buildFromStatement(model, alias);
    const selectStatement = sql.raw`COUNT(*)`;

    const selectClause = this.adapter.builders.select(ctx, selectStatement);
    const fromClause = this.adapter.builders.from(ctx, fromStatement);
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    const clauses: QueryClauses = {
      select: selectClause,
      from: fromClause,
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.count(ctx, clauses);
  }

  private buildAggregateQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "aggregate",
      alias,
    };

    // Build aggregate SELECT statement based on payload._count, _sum, _avg, etc.
    const selectStatement = this.buildAggregateSelectStatement(
      model,
      payload,
      alias
    );
    const fromStatement = this.buildFromStatement(model, alias);
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    const selectClause = this.adapter.builders.select(ctx, selectStatement);
    const fromClause = this.adapter.builders.from(ctx, fromStatement);
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    const clauses: QueryClauses = {
      select: selectClause,
      from: fromClause,
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.aggregate(ctx, clauses);
  }

  private buildGroupByQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "groupBy",
      alias,
    };

    const selectStatement = this.buildGroupBySelectStatement(
      model,
      payload,
      alias
    );
    const fromStatement = this.buildFromStatement(model, alias);
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;
    const groupByStatement = this.buildGroupByStatement(
      model,
      payload.by,
      alias
    );
    const havingStatement = payload.having
      ? this.buildWhereStatement(model, payload.having, alias)
      : sql.empty;
    const orderByStatement = payload.orderBy
      ? this.buildOrderByStatement(model, payload.orderBy, alias)
      : sql.empty;

    const selectClause = this.adapter.builders.select(ctx, selectStatement);
    const fromClause = this.adapter.builders.from(ctx, fromStatement);
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;
    const groupByClause = this.adapter.builders.groupBy(ctx, groupByStatement);
    const havingClause =
      havingStatement !== sql.empty
        ? this.adapter.builders.having(ctx, havingStatement)
        : undefined;
    const orderByClause =
      orderByStatement !== sql.empty
        ? this.adapter.builders.orderBy(ctx, orderByStatement)
        : undefined;

    const clauses: QueryClauses = {
      select: selectClause,
      from: fromClause,
      ...(whereClause && { where: whereClause }),
      ...(orderByClause && { orderBy: orderByClause }),
    };

    return this.adapter.operations.groupBy(ctx, clauses);
  }

  private buildCreateQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "create",
      alias,
    };

    return this.adapter.operations.create(ctx, payload);
  }

  private buildCreateManyQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "createMany",
      alias,
    };

    return this.adapter.operations.createMany(ctx, payload);
  }

  private buildUpdateQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "update",
      alias,
      // Pass the data through context so adapter can access it
      ...(payload.data && { data: payload.data }),
    };

    // Pre-process WHERE clause if present
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    // Build WHERE clause using builders
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    // Create processed clauses for the adapter
    const clauses: QueryClauses = {
      select: sql.empty, // Not needed for update
      from: sql.empty, // Not needed for update
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.update(ctx, clauses);
  }

  private buildUpdateManyQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "updateMany",
      alias,
      // Pass the data through context so adapter can access it
      ...(payload.data && { data: payload.data }),
    };

    // Pre-process WHERE clause if present
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    // Build WHERE clause using builders
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    // Create processed clauses for the adapter
    const clauses: QueryClauses = {
      select: sql.empty, // Not needed for updateMany
      from: sql.empty, // Not needed for updateMany
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.updateMany(ctx, clauses);
  }

  private buildDeleteQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "delete",
      alias,
    };

    // Pre-process WHERE clause if present
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    // Build WHERE clause using builders
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    // Create processed clauses for the adapter
    const clauses: QueryClauses = {
      select: sql.empty, // Not needed for delete
      from: sql.empty, // Not needed for delete
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.delete(ctx, clauses);
  }

  private buildDeleteManyQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "deleteMany",
      alias,
    };

    // Pre-process WHERE clause if present
    const whereStatement = payload.where
      ? this.buildWhereStatement(model, payload.where, alias)
      : sql.empty;

    // Build WHERE clause using builders
    const whereClause =
      whereStatement !== sql.empty
        ? this.adapter.builders.where(ctx, whereStatement)
        : undefined;

    // Create processed clauses for the adapter
    const clauses: QueryClauses = {
      select: sql.empty, // Not needed for deleteMany
      from: sql.empty, // Not needed for deleteMany
      ...(whereClause && { where: whereClause }),
    };

    return this.adapter.operations.deleteMany(ctx, clauses);
  }

  private buildUpsertQuery(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const ctx: BuilderContext = {
      model,
      baseOperation: "upsert",
      alias,
      // Pass upsert-specific data through context
      ...(payload.where && { where: payload.where }),
      ...(payload.create && { create: payload.create }),
      ...(payload.update && { update: payload.update }),
    };

    // For upsert, we don't need to pre-process WHERE since it's used differently
    // The adapter will handle the conflict detection based on the where clause
    return this.adapter.operations.upsert(ctx, payload);
  }

  // ================================
  // Statement Building Methods (generate raw SQL fragments)
  // ================================

  private buildSelectStatement(
    model: Model<any>,
    select: any,
    alias: string
  ): Sql {
    const fields: Sql[] = [];

    if (select === null || select === undefined) {
      // Default: select all scalar fields (no relations by default)
      // This happens when using include (no explicit select) or when select is not specified
      for (const [fieldName] of model.fields) {
        fields.push(sql.raw`"${alias}"."${fieldName}"`);
      }
    } else {
      // Selective fields - handle only scalar fields now (relations handled separately)
      for (const [fieldName, include] of Object.entries(select)) {
        if (include === true && model.fields.has(fieldName)) {
          // Scalar field selection
          fields.push(sql.raw`"${alias}"."${fieldName}"`);
        } else if (model.relations.has(fieldName)) {
          // Relations are handled in buildAllRelationSubqueries - skip here
          continue;
        } else if (include === true) {
          // Field/relation not found
          throw new ValidationError(
            `Field or relation '${fieldName}' not found on model '${model.name}' in select clause`,
            { model: model.name, field: fieldName }
          );
        }
      }
    }

    return sql.join(fields, ", ");
  }

  private buildRelationLinkCondition(
    relation: Relation<any, any>,
    parentAlias: string,
    childAlias: string
  ): any {
    // This will depend on the relation type and foreign key setup
    // For now, return a basic condition that the adapter can handle
    // The actual implementation will depend on how relations are configured

    const relationType = relation["~relationType"];
    const onField = relation["~onField"];
    const refField = relation["~refField"];

    // Basic foreign key relationship condition
    if (onField && refField) {
      return {
        [refField]: {
          // Create a reference to parent field - this will need adapter-specific handling
          _parentRef: `${parentAlias}.${onField}`,
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

  private buildFromStatement(model: Model<any>, alias: string): Sql {
    const tableName = model.tableName || model.name;
    return sql.raw`"${tableName}" AS "${alias}"`;
  }

  private buildWhereStatement(
    model: Model<any>,
    where: any,
    alias: string
  ): Sql {
    const conditions: Sql[] = [];

    try {
      for (const [fieldName, condition] of Object.entries(where)) {
        if (fieldName === "AND" || fieldName === "OR" || fieldName === "NOT") {
          // Handle logical operators
          conditions.push(
            this.buildLogicalCondition(
              model,
              fieldName,
              condition as any,
              alias
            )
          );
        } else if (model.fields.has(fieldName)) {
          // Validate field exists
          this.validateField(model, fieldName);
          // Handle field conditions
          conditions.push(
            this.buildFieldCondition(model, fieldName, condition, alias)
          );
        } else if (model.relations.has(fieldName)) {
          // Validate relation exists
          this.validateRelation(model, fieldName);
          // Handle relation conditions
          conditions.push(
            this.buildRelationCondition(model, fieldName, condition, alias)
          );
        } else {
          // Field/relation not found
          throw new ValidationError(
            `Field or relation '${fieldName}' not found on model '${model.name}'`,
            { model: model.name, field: fieldName }
          );
        }
      }

      if (conditions.length === 0) {
        return sql.empty;
      }

      return sql.join(conditions, " AND ");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build where statement: ${errorMessage}`,
        { model: model.name }
      );
    }
  }

  private buildOrderByStatement(
    model: Model<any>,
    orderBy: any,
    alias: string
  ): Sql {
    const orders: Sql[] = [];

    try {
      if (Array.isArray(orderBy)) {
        for (const order of orderBy) {
          orders.push(
            ...this.parseOrderByObject(order, alias, model).map(
              (s) => sql.raw`${s}`
            )
          );
        }
      } else {
        orders.push(
          ...this.parseOrderByObject(orderBy, alias, model).map(
            (s) => sql.raw`${s}`
          )
        );
      }

      return sql.join(orders, ", ");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build order by statement: ${errorMessage}`,
        { model: model.name }
      );
    }
  }

  private parseOrderByObject(
    orderBy: any,
    alias: string,
    model: Model<any>
  ): string[] {
    const orders: string[] = [];

    for (const [field, direction] of Object.entries(orderBy)) {
      // Validate field exists
      this.validateField(model, field);

      if (typeof direction === "string") {
        const validDirections = ["asc", "desc", "ASC", "DESC"];
        if (!validDirections.includes(direction)) {
          throw new ValidationError(
            `Invalid order direction '${direction}'. Must be 'asc' or 'desc'`,
            { model: model.name, field }
          );
        }
        orders.push(`"${alias}"."${field}" ${direction.toUpperCase()}`);
      }
    }

    return orders;
  }

  private buildLimitStatement(take?: number, skip?: number): Sql {
    const parts: Sql[] = [];

    try {
      if (take !== undefined) {
        if (take < 0) {
          throw new ValidationError("LIMIT value must be non-negative");
        }
        parts.push(sql`LIMIT ${take}`);
      }

      if (skip !== undefined) {
        if (skip < 0) {
          throw new ValidationError("OFFSET value must be non-negative");
        }
        if (parts.length > 0) {
          parts.push(sql`OFFSET `);
        } else {
          parts.push(sql`OFFSET `);
        }
        parts.push(sql`${skip}`);
      }

      return sql.join(parts, " ");
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build limit statement: ${errorMessage}`
      );
    }
  }

  // ================================
  // Condition Building Methods
  // ================================

  private buildFieldCondition(
    model: Model<any>,
    fieldName: string,
    condition: any,
    alias: string
  ): Sql {
    try {
      const field = model.fields.get(fieldName);
      if (!field) {
        throw new ValidationError(
          `Field '${fieldName}' not found on model '${model.name}'`,
          { model: model.name, field: fieldName }
        );
      }

      const ctx: BuilderContext = {
        model,
        field: field as any,
        baseOperation: "findMany",
        alias,
        fieldName,
      };

      // Handle simple equality
      if (
        typeof condition === "string" ||
        typeof condition === "number" ||
        typeof condition === "boolean"
      ) {
        return sql`${sql.raw`"${alias}"."${fieldName}" = `}${condition}`;
      }

      // Handle null values
      if (condition === null) {
        return sql.raw`"${alias}"."${fieldName}" IS NULL`;
      }

      // Handle complex filters using generic pattern
      return this.applyFieldFilter(ctx, condition, fieldName);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build field condition for '${fieldName}': ${errorMessage}`,
        { model: model.name, field: fieldName }
      );
    }
  }

  private buildRelationCondition(
    model: Model<any>,
    relationName: string,
    condition: any,
    alias: string
  ): Sql {
    try {
      const relation = model.relations.get(relationName);
      if (!relation) {
        throw new ValidationError(
          `Relation '${relationName}' not found on model '${model.name}'`,
          { model: model.name, relation: relationName }
        );
      }

      const ctx: BuilderContext = {
        model,
        relation,
        baseOperation: "findMany",
        alias,
      };

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
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build relation condition for '${relationName}': ${errorMessage}`,
        { model: model.name, relation: relationName }
      );
    }
  }

  private buildLogicalCondition(
    model: Model<any>,
    operator: string,
    conditions: any,
    alias: string
  ): Sql {
    try {
      const ctx: BuilderContext = {
        model,
        baseOperation: "findMany",
        alias,
      };

      if (!Array.isArray(conditions) && typeof conditions !== "object") {
        throw new ValidationError(
          `Logical operator '${operator}' requires array or object conditions`,
          { model: model.name }
        );
      }

      const conditionSqls = Array.isArray(conditions)
        ? conditions.map((cond) => this.buildWhereStatement(model, cond, alias))
        : [this.buildWhereStatement(model, conditions, alias)];

      if (conditionSqls.length === 0) {
        throw new ValidationError(
          `Logical operator '${operator}' requires at least one condition`,
          { model: model.name }
        );
      }

      switch (operator) {
        case "AND":
          return this.adapter.builders.AND(ctx, ...conditionSqls);
        case "OR":
          return this.adapter.builders.OR(ctx, ...conditionSqls);
        case "NOT":
          const firstCondition = conditionSqls[0];
          if (!firstCondition) {
            throw new ValidationError(
              "NOT operator requires at least one condition"
            );
          }
          return this.adapter.builders.NOT(ctx, firstCondition);
        default:
          throw new ValidationError(
            `Unsupported logical operator: ${operator}`
          );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build logical condition '${operator}': ${errorMessage}`,
        { model: model.name }
      );
    }
  }

  // ================================
  // Generic Filter Application
  // ================================

  private applyFieldFilter(
    ctx: BuilderContext,
    condition: any,
    fieldName: string
  ): Sql {
    try {
      const field = ctx.field!;
      const fieldType = field["~fieldType"];

      if (!condition || typeof condition !== "object") {
        throw new ValidationError(
          `Field filter condition for '${fieldName}' must be an object`,
          { model: ctx.model.name, field: fieldName }
        );
      }

      // Get the filter operation and value
      const entries = Object.entries(condition);
      if (entries.length !== 1) {
        throw new ValidationError(
          `Field filter condition for '${fieldName}' must have exactly one operation`,
          { model: ctx.model.name, field: fieldName }
        );
      }

      const [operation, value] = entries[0] as [string, any];

      // Get the appropriate filter handler based on field type
      const filterGroup = this.getFilterGroup(fieldType);
      if (!filterGroup) {
        throw new ValidationError(
          `No filter group found for field type '${fieldType}'`,
          { model: ctx.model.name, field: fieldName }
        );
      }

      const filterHandler = filterGroup[operation] as FilterHandler;
      if (!filterHandler) {
        const availableOperations = Object.keys(filterGroup).join(", ");
        throw new ValidationError(
          `Unsupported filter operation '${operation}' for field type '${fieldType}'. Available operations: ${availableOperations}`,
          { model: ctx.model.name, field: fieldName }
        );
      }

      return filterHandler(ctx, value);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to apply field filter: ${errorMessage}`,
        { model: ctx.model.name, field: fieldName }
      );
    }
  }

  private getFilterGroup(
    fieldType: string
  ): Record<string, FilterHandler> | undefined {
    switch (fieldType) {
      case "string":
        return this.adapter.filters.string;
      case "int":
      case "float":
      case "decimal":
        return this.adapter.filters.number;
      case "bigInt":
        return this.adapter.filters.bigint;
      case "boolean":
        return this.adapter.filters.boolean;
      case "dateTime":
        return this.adapter.filters.dateTime;
      case "json":
        return this.adapter.filters.json;
      case "enum":
        return this.adapter.filters.enum;
      default:
        return undefined;
    }
  }

  // ================================
  // Relation Methods
  // ================================

  private resolveRelationModel(relation: Relation<any, any>): Model<any> {
    try {
      const model = relation.getter();
      if (!model) {
        throw new ValidationError(`Relation target model not found`, {
          model: "unknown",
        });
      }
      return model;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to resolve relation model: ${errorMessage}`,
        { model: "unknown" }
      );
    }
  }

  // ================================
  // Utility Methods
  // ================================

  private generateAlias(): string {
    return `t${this.aliasCounter++}`;
  }

  private getTableName(model: Model<any>): string {
    return model.tableName || model.name;
  }

  // ================================
  // Additional Statement Building Methods
  // ================================

  private buildAggregateSelectStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const aggregations: Sql[] = [];

    // Handle different aggregate functions
    if (payload._count) {
      if (payload._count === true) {
        aggregations.push(sql.raw`COUNT(*) AS _count`);
      } else {
        // Handle field-specific counts
        for (const [field, include] of Object.entries(payload._count)) {
          if (include === true) {
            aggregations.push(
              sql.raw`COUNT("${alias}"."${field}") AS "_count_${field}"`
            );
          }
        }
      }
    }

    if (payload._sum) {
      for (const [field, include] of Object.entries(payload._sum)) {
        if (include === true) {
          aggregations.push(
            sql.raw`SUM("${alias}"."${field}") AS "_sum_${field}"`
          );
        }
      }
    }

    if (payload._avg) {
      for (const [field, include] of Object.entries(payload._avg)) {
        if (include === true) {
          aggregations.push(
            sql.raw`AVG("${alias}"."${field}") AS "_avg_${field}"`
          );
        }
      }
    }

    if (payload._min) {
      for (const [field, include] of Object.entries(payload._min)) {
        if (include === true) {
          aggregations.push(
            sql.raw`MIN("${alias}"."${field}") AS "_min_${field}"`
          );
        }
      }
    }

    if (payload._max) {
      for (const [field, include] of Object.entries(payload._max)) {
        if (include === true) {
          aggregations.push(
            sql.raw`MAX("${alias}"."${field}") AS "_max_${field}"`
          );
        }
      }
    }

    return sql.join(aggregations, ", ");
  }

  private buildGroupBySelectStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const selections: Sql[] = [];

    // Add groupBy fields to SELECT
    if (Array.isArray(payload.by)) {
      for (const field of payload.by) {
        selections.push(sql.raw`"${alias}"."${field}"`);
      }
    } else {
      selections.push(sql.raw`"${alias}"."${payload.by}"`);
    }

    // Add aggregations if present
    const aggregateStatement = this.buildAggregateSelectStatement(
      model,
      payload,
      alias
    );
    if (aggregateStatement.strings[0]) {
      selections.push(sql.raw`${aggregateStatement.strings[0]}`);
    }

    return sql.join(selections, ", ");
  }

  private buildGroupByStatement(
    model: Model<any>,
    by: any,
    alias: string
  ): Sql {
    const fields: Sql[] = [];

    if (Array.isArray(by)) {
      for (const field of by) {
        fields.push(sql.raw`"${alias}"."${field}"`);
      }
    } else {
      fields.push(sql.raw`"${alias}"."${by}"`);
    }
    return sql.join(fields, ", ");
  }

  private buildAllRelationSubqueries(
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
          const subquery = this.buildUnifiedRelationSubquery(
            relation,
            value,
            alias,
            fieldName
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
        const subquery = this.buildUnifiedRelationSubquery(
          relation,
          relationArgs,
          alias,
          relationName
        );
        relationSubqueries.push(subquery);
      }
    }

    return relationSubqueries;
  }

  private buildUnifiedRelationSubquery(
    relation: Relation<any, any>,
    relationArgs: any,
    parentAlias: string,
    relationFieldName: string
  ): Sql {
    try {
      const targetModel = this.resolveRelationModel(relation);
      const childAlias = this.generateAlias();

      // Validate the target model
      this.validateModel(targetModel);

      const ctx: BuilderContext = {
        model: targetModel,
        relation,
        baseOperation: "findMany",
        alias: childAlias,
        parentAlias,
      };

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
        throw new ValidationError(
          `Invalid relation arguments for '${relationFieldName}'. Must be true or object with select/include properties`,
          { model: targetModel.name, relation: relationFieldName }
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
      return sql`(${wrappedSubquery}) AS "${relationFieldName}"`;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new QueryParserError(
        `Failed to build relation subquery for '${relationFieldName}': ${errorMessage}`,
        {
          model: this.resolveRelationModel(relation).name,
          relation: relationFieldName,
        }
      );
    }
  }

  private combineWhereConditions(userWhere: any, linkWhere: any): any {
    if (!userWhere) {
      return linkWhere;
    }

    if (!linkWhere) {
      return userWhere;
    }

    // Combine user where conditions with relation link conditions using AND
    return {
      AND: [userWhere, linkWhere],
    };
  }

  private buildRelationFilterSubquery(
    relation: Relation<any, any>,
    condition: any,
    alias: string
  ): Sql {
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.generateAlias();

    const ctx: BuilderContext = {
      model: targetModel,
      relation,
      baseOperation: "findMany",
      alias: childAlias,
    };

    let relationPayload: any = {};

    if (condition === true) {
      relationPayload = {
        where: this.buildRelationLinkCondition(relation, alias, childAlias),
      };
    } else if (typeof condition === "object" && condition !== null) {
      relationPayload = {
        ...condition,
        where: this.combineWhereConditions(
          condition.where,
          this.buildRelationLinkCondition(relation, alias, childAlias)
        ),
      };
    } else {
      throw new ValidationError(`Invalid relation filter condition format`, {
        model: targetModel.name,
        relation: relation.getter().name,
      });
    }

    return this.buildSelectQuery(
      targetModel,
      relationPayload,
      childAlias,
      "findMany"
    );
  }
}

export { QueryParser };
