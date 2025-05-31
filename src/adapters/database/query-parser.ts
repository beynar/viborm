import { Sql, sql } from "../../sql/sql";
import { Model } from "../../schema/model";
import { Operation } from "../../types/client/operations/defintion";
import { Field, Relation } from "../../schema";
import { DatabaseAdapter, QueryClauses } from "./database-adapter";
import { QueryValidator } from "./query-validator";
import { QueryErrors, QueryParserError, ValidationError } from "./query-errors";

// Re-export error classes for consumers
export { QueryParserError, ValidationError, QueryErrors } from "./query-errors";

// ================================
// Core Types
// ================================

export type BuilderContext = {
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
  // Main Entry Points
  // ================================

  static parse(
    operation: Operation,
    model: Model<any>,
    payload: any,
    adapter: DatabaseAdapter
  ): Sql {
    const parser = new QueryParser(adapter);

    // Use the external validator
    QueryValidator.validateQuery(operation, model, payload, (relation) =>
      parser.resolveRelationModel(relation)
    );

    // Generate alias and build query directly
    const alias = parser.generateAlias();
    const ctx = parser.createContextFromPayload(
      model,
      operation,
      alias,
      payload
    );

    // Build all possible clauses - adapters will use what they need
    const clauses = parser.buildQueryClauses(model, payload, alias, operation);

    // Let the adapter handle the specific operation
    return parser.adapter.operations[operation](ctx, clauses);
  }

  // ================================
  // Query Clause Builder
  // ================================

  private buildQueryClauses(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): QueryClauses {
    const ctx = this.createContextFromPayload(model, operation, alias, payload);

    // Build SELECT clause based on operation type
    const selectStatement = this.buildSelectClause(
      model,
      payload,
      alias,
      operation
    );
    const selectClause = this.adapter.builders.select(ctx, selectStatement);

    // Build FROM clause (always needed)
    const fromStatement = this.buildFromStatement(model, alias);
    const fromClause = this.adapter.builders.from(ctx, fromStatement);

    // Build optional clauses
    const clauses: QueryClauses = {
      select: selectClause,
      from: fromClause,
    };

    // WHERE clause (if present)
    if (payload.where) {
      const whereStatement = this.buildWhereStatement(
        model,
        payload.where,
        alias
      );
      clauses.where = this.adapter.builders.where(ctx, whereStatement);
    }

    // ORDER BY clause (if present)
    if (payload.orderBy) {
      const orderByStatement = this.buildOrderByStatement(
        model,
        payload.orderBy,
        alias
      );
      clauses.orderBy = this.adapter.builders.orderBy(ctx, orderByStatement);
    }

    // LIMIT clause (if take/skip present)
    if (payload.take !== undefined || payload.skip !== undefined) {
      clauses.limit = this.adapter.builders.limit(ctx, sql.empty);
    }

    // GROUP BY clause (for groupBy operations)
    if (payload.by) {
      const groupByStatement = this.buildGroupByStatement(
        model,
        payload.by,
        alias
      );
      clauses.groupBy = this.adapter.builders.groupBy(ctx, groupByStatement);
    }

    // HAVING clause (for groupBy operations)
    if (payload.having) {
      const havingStatement = this.buildWhereStatement(
        model,
        payload.having,
        alias
      );
      clauses.having = this.adapter.builders.having(ctx, havingStatement);
    }

    // INCLUDE clause (relation subqueries)
    const relationSubqueries = this.buildAllRelationSubqueries(
      model,
      payload,
      alias
    );
    if (relationSubqueries.length > 0) {
      clauses.include = relationSubqueries;
    }

    return clauses;
  }

  // ================================
  // Smart SELECT Clause Builder
  // ================================

  private buildSelectClause(
    model: Model<any>,
    payload: any,
    alias: string,
    operation: Operation
  ): Sql {
    const ctx = this.createContext(model, operation, alias);

    switch (operation) {
      case "count":
        return this.adapter.builders.count(ctx, sql.raw`*`);

      case "aggregate":
        return this.buildAggregateStatement(model, payload, alias);

      case "groupBy":
        return this.buildGroupBySelectStatement(model, payload, alias);

      default:
        // Standard field selection for findMany, findFirst, etc.
        return this.buildSelectStatement(model, payload.select, alias);
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
    const ctx = this.createContextFromPayload(model, operation, alias, payload);

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

    // Let adapter handle limit/offset with take/skip values from context
    const limitClause =
      payload.take !== undefined || payload.skip !== undefined
        ? this.adapter.builders.limit(ctx, sql.empty)
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
          QueryErrors.fieldOrRelationNotFound(fieldName, model.name, []);
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
    return this.adapter.identifiers.table(tableName, alias);
  }

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
        // Validate field exists
        QueryValidator.validateField(model, fieldName);
        // Handle field conditions
        conditions.push(
          this.buildFieldCondition(model, fieldName, condition, alias)
        );
      } else if (model.relations.has(fieldName)) {
        // Validate relation exists
        QueryValidator.validateRelation(model, fieldName);
        // Handle relation conditions
        conditions.push(
          this.buildRelationCondition(model, fieldName, condition, alias)
        );
      } else {
        // Field/relation not found
        const availableFields = Array.from(model.fields.keys());
        const availableRelations = Array.from(model.relations.keys());
        const available = [...availableFields, ...availableRelations];
        QueryErrors.fieldOrRelationNotFound(fieldName, model.name, available);
      }
    }

    if (conditions.length === 0) {
      return sql.empty;
    }
    const ctx = this.createContext(model, "findMany", alias);
    return this.adapter.builders.AND(ctx, ...conditions);
  }

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

    return sql.join(orders, ", ");
  }

  private parseOrderByObject(
    orderBy: any,
    alias: string,
    model: Model<any>
  ): Sql[] {
    const orders: Sql[] = [];

    for (const [field, direction] of Object.entries(orderBy)) {
      // Validate field exists
      QueryValidator.validateField(model, field);

      if (typeof direction === "string") {
        const validDirections = ["asc", "desc", "ASC", "DESC"];
        if (!validDirections.includes(direction)) {
          QueryErrors.invalidOrderDirection(direction, field, model.name);
        }
        const columnRef = this.adapter.identifiers.column(alias, field);
        orders.push(sql`${columnRef} ${sql.raw`${direction.toUpperCase()}`}`);
      }
    }

    return orders;
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
    const field = model.fields.get(fieldName);
    if (!field) {
      const availableFields = Array.from(model.fields.keys());
      QueryErrors.fieldNotFound(model.name, fieldName, availableFields);
    }

    const ctx = this.createContext(model, "findMany", alias, {
      field: field as any,
      fieldName,
    });

    // Handle simple equality by converting to explicit equals filter
    if (
      typeof condition === "string" ||
      typeof condition === "number" ||
      typeof condition === "boolean"
    ) {
      return this.applyFieldFilter(ctx, { equals: condition }, fieldName);
    }

    // Handle null values
    if (condition === null) {
      // Use field-specific null handling through filters
      return this.applyFieldFilter(ctx, { equals: null }, fieldName);
    }

    // Handle complex filters using generic pattern
    return this.applyFieldFilter(ctx, condition, fieldName);
  }

  private buildRelationCondition(
    model: Model<any>,
    relationName: string,
    condition: any,
    alias: string
  ): Sql {
    const relation = model.relations.get(relationName);
    if (!relation) {
      const availableRelations = Array.from(model.relations.keys());
      QueryErrors.relationNotFound(
        model.name,
        relationName,
        availableRelations
      );
    }

    const ctx = this.createContext(model, "findMany", alias, {
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

  private buildLogicalCondition(
    model: Model<any>,
    operator: string,
    conditions: any,
    alias: string
  ): Sql {
    const ctx = this.createContext(model, "findMany", alias);

    if (!Array.isArray(conditions) && typeof conditions !== "object") {
      QueryErrors.logicalOperatorRequiresConditions(operator, model.name);
    }

    const conditionSqls = Array.isArray(conditions)
      ? conditions.map((cond) => this.buildWhereStatement(model, cond, alias))
      : [this.buildWhereStatement(model, conditions, alias)];

    if (conditionSqls.length === 0) {
      QueryErrors.logicalOperatorNeedsAtLeastOne(operator, model.name);
    }

    switch (operator) {
      case "AND":
        return this.adapter.builders.AND(ctx, ...conditionSqls);
      case "OR":
        return this.adapter.builders.OR(ctx, ...conditionSqls);
      case "NOT":
        const firstCondition = conditionSqls[0];
        if (!firstCondition) {
          QueryErrors.notOperatorNeedsCondition();
        }
        return this.adapter.builders.NOT(ctx, firstCondition);
      default:
        QueryErrors.unsupportedLogicalOperator(operator);
    }
  }

  /**
   * Handles abstract conditions that are not actual model fields/relations
   * These are internal conditions used for relation linking and other meta operations
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
      default:
        QueryErrors.unknownAbstractCondition(fieldName, model.name);
    }
  }

  /**
   * Builds SQL for relation link conditions
   * Converts abstract relation metadata into concrete SQL JOIN conditions
   */
  private buildRelationLinkSQL(condition: any, alias: string): Sql {
    const { parentAlias, childAlias, relationType, onField, refField } =
      condition;

    // Generate the appropriate SQL condition based on relation type
    if (onField && refField) {
      // Foreign key relationship: child.refField = parent.onField
      const childCol = this.adapter.identifiers.column(
        childAlias || alias,
        refField
      );
      const parentCol = this.adapter.identifiers.column(parentAlias, onField);
      return sql`${childCol} = ${parentCol}`;
    }

    // Fallback for complex relations
    QueryErrors.relationLinkGenerationFailed(relationType);
  }

  /**
   * Builds SQL for parent reference conditions
   * Handles conditions like: { _parentRef: "t0.userId" }
   */
  private buildParentRefSQL(condition: any, alias: string): Sql {
    if (typeof condition !== "string" || !condition.includes(".")) {
      QueryErrors.invalidParentRef(condition);
    }

    const [parentAlias, parentField] = condition.split(".");

    if (!parentAlias || !parentField) {
      QueryErrors.invalidParentRef(condition);
    }

    return this.adapter.identifiers.column(parentAlias, parentField);
  }

  // ================================
  // Generic Filter Application
  // ================================

  private applyFieldFilter(
    ctx: BuilderContext,
    condition: any,
    fieldName: string
  ): Sql {
    const field = ctx.field!;
    const fieldType = field["~fieldType"];

    if (!condition || typeof condition !== "object") {
      QueryErrors.filterConditionInvalid(fieldName, ctx.model.name);
    }

    // Get the filter operation and value
    const entries = Object.entries(condition);
    if (entries.length !== 1) {
      QueryErrors.filterOperationInvalid(fieldName, ctx.model.name);
    }

    const [operation, value] = entries[0] as [string, any];

    // Get the appropriate filter handler based on field type
    const filterGroup = this.getFilterGroup(fieldType);
    if (!filterGroup) {
      QueryErrors.filterGroupNotFound(fieldType, fieldName, ctx.model.name);
    }

    const filterHandler = filterGroup[operation] as FilterHandler;
    if (!filterHandler) {
      const availableOperations = Object.keys(filterGroup);
      QueryErrors.filterOperationUnsupported(
        operation,
        fieldType,
        fieldName,
        ctx.model.name,
        availableOperations
      );
    }

    return filterHandler(ctx, value);
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
    const model = relation.getter();
    if (!model) {
      QueryErrors.relationModelNotFound();
    }
    return model;
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

  private buildAggregateStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    const aggregations: Sql[] = [];
    const ctx = this.createContext(model, "aggregate", alias);

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

    return sql.join(aggregations, ", ");
  }

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

  private buildAggregateSelectStatement(
    model: Model<any>,
    payload: any,
    alias: string
  ): Sql {
    return this.buildAggregateStatement(model, payload, alias);
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
        selections.push(this.adapter.identifiers.column(alias, field));
      }
    } else {
      selections.push(this.adapter.identifiers.column(alias, payload.by));
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
        fields.push(this.adapter.identifiers.column(alias, field));
      }
    } else {
      fields.push(this.adapter.identifiers.column(alias, by));
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
          QueryValidator.validateRelation(model, fieldName);
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
        QueryValidator.validateRelation(model, relationName);
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
    const targetModel = this.resolveRelationModel(relation);
    const childAlias = this.generateAlias();

    // Validate the target model
    QueryValidator.validateModel(targetModel);

    const ctx = this.createContext(targetModel, "findMany", childAlias, {
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
      QueryErrors.invalidRelationArguments(relationFieldName, targetModel.name);
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

    const ctx = this.createContext(targetModel, "findMany", childAlias, {
      relation,
      parentAlias: alias,
    });

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
      QueryErrors.invalidRelationFilterFormat(
        targetModel.name,
        relation.getter().name
      );
    }

    return this.buildSelectQuery(
      targetModel,
      relationPayload,
      childAlias,
      "findMany"
    );
  }

  // ================================
  // Context Factory
  // ================================

  private createContext(
    model: Model<any>,
    operation: Operation,
    alias: string,
    options: {
      field?: Field<any>;
      relation?: Relation<any, any>;
      parentAlias?: string;
      fieldName?: string;
    } = {}
  ): BuilderContext {
    return {
      model,
      baseOperation: operation,
      alias,
      ...options,
    };
  }

  private createContextFromPayload(
    model: Model<any>,
    operation: Operation,
    alias: string,
    payload: any,
    options: {
      field?: Field<any>;
      relation?: Relation<any, any>;
      parentAlias?: string;
      fieldName?: string;
    } = {}
  ): BuilderContext {
    return this.createContext(model, operation, alias, {
      ...options,
    });
  }
}

export { QueryParser };
