// SQL AST Visitor for BaseORM
// Global visitor that recursively traverses AST and delegates SQL generation to database adapters

import {
  QueryAST,
  QueryArgsAST,
  ConditionAST,
  SelectionAST,
  AggregationAST,
  OrderingAST,
  GroupByAST,
  CursorAST,
  ValueAST,
  DataAST,
  BatchDataAST,
  InclusionAST,
  FieldConditionTarget,
  RelationConditionTarget,
  LogicalConditionTarget,
  FieldOrderingTarget,
  AggregateOrderingTarget,
  RelationOrderingTarget,
  ModelReference,
  AggregationFieldAST,
} from "./ast";

// ================================
// Database Adapter Interface
// ================================

export interface QueryParts {
  operation: string;
  table: string;
  select?: string;
  where?: string;
  orderBy?: string;
  groupBy?: string;
  having?: string;
  limit?: string;
  offset?: string;
}

export interface RelationInfo {
  sourceTable: string;
  targetTable: string;
  relationName: string;
  sourceField?: string;
  targetField?: string;
  relationType: "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many";
}

export interface BatchOptions {
  skipDuplicates?: boolean;
  updateOnConflict?: boolean;
}

export interface DatabaseAdapter {
  // Core query building
  buildQuery(parts: QueryParts): string;

  // Clause builders (receive processed child fragments)
  buildSelectClause(fields: string[]): string;
  buildWhereClause(conditions: string[]): string;
  buildOrderByClause(orderings: string[]): string;
  buildGroupByClause(fields: string[]): string;
  buildHavingClause(conditions: string[]): string;

  // Condition builders (atomic operations)
  buildFieldCondition(field: string, operator: string, value: string): string;
  buildLogicalCondition(
    operator: "AND" | "OR" | "NOT",
    conditions: string[]
  ): string;
  buildRelationCondition(
    relation: RelationInfo,
    operation: string,
    subquery: string
  ): string;

  // Value and identifier formatting
  formatValue(value: any, type: string): string;
  formatIdentifier(identifier: string): string;
  formatTableName(table: string): string;

  // Operation-specific builders
  buildInsertQuery(table: string, fields: string[], values: string[][]): string;
  buildUpdateQuery(
    table: string,
    setClauses: string[],
    whereClause?: string
  ): string;
  buildDeleteQuery(table: string, whereClause?: string): string;
  buildUpsertQuery(
    table: string,
    insertFields: string[],
    insertValues: string[],
    conflictTarget: string,
    updateClauses: string[],
    whereClause?: string
  ): string;

  // Aggregation builders
  buildAggregateQuery(
    table: string,
    aggregations: string[],
    whereClause?: string,
    groupBy?: string[],
    having?: string[]
  ): string;
  buildCountQuery(table: string, field?: string, whereClause?: string): string;

  // Batch operations
  buildBatchInsert(
    table: string,
    fields: string[],
    valueRows: string[][],
    options?: BatchOptions
  ): string;
  buildBatchUpdate(
    table: string,
    setClauses: string[],
    whereClause?: string
  ): string;
  buildBatchDelete(table: string, whereClause?: string): string;

  // Pagination
  buildLimitOffset(limit?: number, offset?: number): string;
  buildCursorPagination(
    field: string,
    value: string,
    direction: "forward" | "backward"
  ): string;

  // JSON aggregation methods for nested relations
  buildJsonObject(keyValuePairs: Array<{ key: string; value: string }>): string;
  buildJsonArray(elements: string[]): string;
  buildJsonArrayAgg(expression: string): string;
  buildNestedRelationSubquery(
    relation: RelationInfo,
    selectClause: string,
    whereClause?: string,
    orderByClause?: string,
    limitClause?: string
  ): string;
  buildRelationFieldSelect(
    relation: RelationInfo,
    subquery: string,
    alias: string
  ): string;
}

// ================================
// SQL AST Visitor Implementation
// ================================

export class SQLASTVisitor {
  constructor(private adapter: DatabaseAdapter) {}

  // Main entry point
  visit(ast: QueryAST): string {
    switch (ast.operation) {
      case "findMany":
      case "findFirst":
      case "findUnique":
        return this.visitSelectQuery(ast);
      case "create":
        return this.visitInsertQuery(ast);
      case "update":
        return this.visitUpdateQuery(ast);
      case "upsert":
        return this.visitUpsertQuery(ast);
      case "delete":
        return this.visitDeleteQuery(ast);
      case "aggregate":
      case "count":
        return this.visitAggregateQuery(ast);
      case "groupBy":
        return this.visitGroupByQuery(ast);
      case "createMany":
      case "updateMany":
      case "deleteMany":
        return this.visitBatchQuery(ast);
      default:
        throw new Error(`Unsupported operation: ${ast.operation}`);
    }
  }

  // ================================
  // Query Type Visitors
  // ================================

  private visitSelectQuery(ast: QueryAST): string {
    const parts: QueryParts = {
      operation: ast.operation,
      table: this.adapter.formatTableName(ast.model.name),
    };

    // Visit children and build SQL fragments
    if (ast.args.select) {
      parts.select = this.visitSelect(ast.args.select);
    }

    // Handle includes as part of select clause with JSON subqueries
    if (ast.args.include) {
      const includeSelects = this.visitIncludes(ast.args.include, ast.model);
      if (parts.select) {
        parts.select = `${parts.select}, ${includeSelects}`;
      } else {
        parts.select = includeSelects;
      }
    }

    if (ast.args.where) {
      parts.where = this.visitWhereArray(ast.args.where);
    }

    if (ast.args.orderBy) {
      parts.orderBy = this.visitOrderByArray(ast.args.orderBy);
    }

    if (ast.args.groupBy) {
      parts.groupBy = this.visitGroupByArray(ast.args.groupBy);
    }

    if (ast.args.having) {
      parts.having = this.visitWhereArray(ast.args.having); // Same as WHERE
    }

    if (ast.args.take || ast.args.skip) {
      parts.limit = this.adapter.buildLimitOffset(ast.args.take, ast.args.skip);
    }

    if (ast.args.cursor) {
      const cursorCondition = this.visitCursor(ast.args.cursor);
      parts.where = parts.where
        ? this.adapter.buildLogicalCondition("AND", [
            parts.where,
            cursorCondition,
          ])
        : cursorCondition;
    }

    // Let adapter compose the final query
    return this.adapter.buildQuery(parts);
  }

  private visitInsertQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    if (!ast.args.data) {
      throw new Error("INSERT query requires data");
    }

    // Handle single data item
    const dataArray = Array.isArray(ast.args.data)
      ? ast.args.data
      : [ast.args.data];
    const dataItem = dataArray[0] as DataAST;

    const fields = dataItem.fields.map((field) => {
      if (field.target.type !== "FIELD") {
        throw new Error("INSERT only supports field targets");
      }
      return this.adapter.formatIdentifier(field.target.field.name);
    });

    const values = [
      dataItem.fields.map((field) => {
        if (!field.value) {
          throw new Error("INSERT field must have a value");
        }
        if (Array.isArray(field.value)) {
          throw new Error("INSERT field cannot have array value");
        }
        return this.visitValue(field.value);
      }),
    ];

    return this.adapter.buildInsertQuery(table, fields, values);
  }

  private visitUpdateQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    if (
      !ast.args.data ||
      !Array.isArray(ast.args.data) ||
      ast.args.data.length === 0
    ) {
      throw new Error("Update query requires data");
    }

    const updateData = ast.args.data[0];
    if (!updateData || updateData.type !== "DATA") {
      throw new Error("Invalid update data");
    }

    const setClauses: string[] = [];
    for (const field of updateData.fields) {
      if (field.target.type === "FIELD" && field.value) {
        const fieldName = this.adapter.formatIdentifier(
          field.target.field.name
        );
        if (Array.isArray(field.value)) {
          // Handle array values
          const arrayValues = field.value.map((v) => this.visitValue(v));
          const value = `ARRAY[${arrayValues.join(", ")}]`;
          setClauses.push(`${fieldName} = ${value}`);
        } else {
          const value = this.visitValue(field.value);
          setClauses.push(`${fieldName} = ${value}`);
        }
      }
    }

    let whereClause: string | undefined;
    if (ast.args.where && ast.args.where.length > 0) {
      whereClause = this.visitWhereArray(ast.args.where);
    }

    return this.adapter.buildUpdateQuery(table, setClauses, whereClause);
  }

  private visitDeleteQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    const whereClause =
      ast.args.where && ast.args.where.length > 0
        ? this.visitWhereArray(ast.args.where)
        : undefined;

    return this.adapter.buildDeleteQuery(table, whereClause);
  }

  private visitAggregateQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    let aggregations: string[] = [];

    if (ast.args.select && ast.args.select.type === "AGGREGATION") {
      aggregations = this.visitAggregation(
        ast.args.select as AggregationAST
      ).split(", ");
    } else if (ast.operation === "count") {
      aggregations = ["COUNT(*)"];
    }

    const whereClause =
      ast.args.where && ast.args.where.length > 0
        ? this.visitWhereArray(ast.args.where)
        : undefined;

    const groupBy =
      ast.args.groupBy && ast.args.groupBy.length > 0
        ? this.visitGroupByArray(ast.args.groupBy).split(", ")
        : undefined;

    const having =
      ast.args.having && ast.args.having.length > 0
        ? this.visitWhereArray(ast.args.having).split(" AND ")
        : undefined;

    return this.adapter.buildAggregateQuery(
      table,
      aggregations,
      whereClause,
      groupBy,
      having
    );
  }

  private visitGroupByQuery(ast: QueryAST): string {
    // GroupBy is essentially an aggregate query with GROUP BY
    return this.visitAggregateQuery(ast);
  }

  private visitBatchQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    if (!ast.args.data || !(ast.args.data as BatchDataAST).items) {
      throw new Error("Batch query requires batch data");
    }

    const batchData = ast.args.data as BatchDataAST;

    switch (ast.operation) {
      case "createMany":
        return this.visitBatchInsert(table, batchData);
      case "updateMany":
        return this.visitBatchUpdate(table, batchData, ast.args);
      case "deleteMany":
        return this.visitBatchDelete(table, ast.args);
      default:
        throw new Error(`Unknown batch operation: ${ast.operation}`);
    }
  }

  private visitBatchInsert(table: string, batchData: BatchDataAST): string {
    if (batchData.items.length === 0) {
      throw new Error("No data provided for batch insert");
    }

    // Get field names from first item
    const firstItem = batchData.items[0];
    if (!firstItem) {
      throw new Error("No data items in batch");
    }

    const fields = firstItem.fields.map((field) => {
      if (field.target.type !== "FIELD") {
        throw new Error("Batch INSERT only supports field targets");
      }
      return this.adapter.formatIdentifier(field.target.field.name);
    });

    // Build values for each item
    const valueRows = batchData.items.map((item) => {
      return item.fields.map((field) => {
        if (!field.value) {
          throw new Error("Batch INSERT field must have a value");
        }
        if (Array.isArray(field.value)) {
          throw new Error("Batch INSERT field cannot have array value");
        }
        return this.visitValue(field.value);
      });
    });

    const options: BatchOptions = {};
    if (batchData.options?.skipDuplicates !== undefined) {
      options.skipDuplicates = batchData.options.skipDuplicates;
    }
    if (batchData.options?.updateOnConflict !== undefined) {
      options.updateOnConflict = batchData.options.updateOnConflict;
    }

    return this.adapter.buildBatchInsert(table, fields, valueRows, options);
  }

  private visitBatchUpdate(
    table: string,
    batchData: BatchDataAST,
    args: QueryArgsAST
  ): string {
    // For updateMany, typically one data item applied to all matching records
    if (batchData.items.length === 0) {
      throw new Error("No data provided for batch update");
    }

    const dataItem = batchData.items[0];
    if (!dataItem) {
      throw new Error("No data item in batch");
    }

    const setClauses = dataItem.fields.map((field) => {
      if (field.target.type !== "FIELD") {
        throw new Error("Batch UPDATE only supports field targets");
      }
      if (!field.value) {
        throw new Error("Batch UPDATE field must have a value");
      }
      if (Array.isArray(field.value)) {
        throw new Error("Batch UPDATE field cannot have array value");
      }
      const fieldName = this.adapter.formatIdentifier(field.target.field.name);
      const value = this.visitValue(field.value);
      return `${fieldName} = ${value}`;
    });

    const whereClause =
      args.where && args.where.length > 0
        ? this.visitWhereArray(args.where)
        : undefined;

    return this.adapter.buildBatchUpdate(table, setClauses, whereClause);
  }

  private visitBatchDelete(table: string, args: QueryArgsAST): string {
    const whereClause =
      args.where && args.where.length > 0
        ? this.visitWhereArray(args.where)
        : undefined;

    return this.adapter.buildBatchDelete(table, whereClause);
  }

  // ================================
  // Clause Visitors
  // ================================

  private visitWhereArray(conditions: ConditionAST[]): string {
    const conditionStrings = conditions.map((cond) =>
      this.visitCondition(cond)
    );
    return this.adapter.buildWhereClause(conditionStrings);
  }

  private visitCondition(condition: ConditionAST): string {
    switch (condition.target.type) {
      case "FIELD":
        return this.visitFieldCondition(condition);
      case "RELATION":
        return this.visitRelationCondition(condition);
      case "LOGICAL":
        return this.visitLogicalCondition(condition);
      default:
        throw new Error(
          `Unknown condition target type: ${(condition.target as any).type}`
        );
    }
  }

  private visitFieldCondition(condition: ConditionAST): string {
    const target = condition.target as FieldConditionTarget;
    const field = this.adapter.formatIdentifier(target.field.name);
    const operator = condition.operator;

    let value: string;
    if (Array.isArray(condition.value)) {
      // Handle IN, NOT IN operators
      const values = condition.value.map((v) => this.visitValue(v));
      value = `(${values.join(", ")})`;
    } else if (condition.value) {
      value = this.visitValue(condition.value);
    } else {
      value = "";
    }

    return this.adapter.buildFieldCondition(field, operator, value);
  }

  private visitLogicalCondition(condition: ConditionAST): string {
    if (!condition.nested || condition.nested.length === 0) {
      return "";
    }

    const nestedConditions = condition.nested.map((nested) =>
      this.visitCondition(nested)
    );
    const operator = condition.logic || "AND";

    let result = this.adapter.buildLogicalCondition(operator, nestedConditions);

    if (condition.negated) {
      result = this.adapter.buildLogicalCondition("NOT", [result]);
    }

    return result;
  }

  private visitRelationCondition(condition: ConditionAST): string {
    const target = condition.target as RelationConditionTarget;
    const relation = target.relation;

    // Recursively visit nested conditions
    const nestedConditions =
      condition.nested?.map((nested) => this.visitCondition(nested)) || [];
    const subquery =
      nestedConditions.length > 0
        ? this.adapter.buildWhereClause(nestedConditions)
        : "";

    const relationInfo: RelationInfo = {
      sourceTable: relation.sourceModel.name,
      targetTable: relation.targetModel.name,
      relationName: relation.name,
      // TODO: Extract relation type and field mappings from relation metadata
      relationType: "one-to-many", // Default for now
    };

    return this.adapter.buildRelationCondition(
      relationInfo,
      target.operation,
      subquery
    );
  }

  private visitSelect(selection: SelectionAST | AggregationAST): string {
    if (selection.type === "SELECTION") {
      const fields: string[] = [];

      selection.fields.forEach((field) => {
        if (!field.include) return;

        // Check if this is a regular field or a relation
        if (field.field && "field" in field.field) {
          // Regular field
          fields.push(this.adapter.formatIdentifier(field.field.name));
        } else if (field.nested) {
          // This is a relation with nested selection - convert to JSON subquery
          const relationInfo: RelationInfo = {
            sourceTable: selection.model.name,
            targetTable: field.nested.relation.targetModel.name,
            relationName: field.nested.relation.name,
            relationType: this.determineRelationType(field.nested.relation),
          };

          // Build subquery for the nested relation
          let subquerySelect = "*";
          let subqueryWhere: string | undefined;
          let subqueryOrderBy: string | undefined;
          let subqueryLimit: string | undefined;

          if (field.nested.args) {
            const nestedArgs = field.nested.args;

            if (nestedArgs.select) {
              if (nestedArgs.select.type === "SELECTION") {
                subquerySelect = this.visitSelect(nestedArgs.select);
              } else if (nestedArgs.select.type === "AGGREGATION") {
                // Handle aggregation in nested selection
                subquerySelect = this.buildNestedAggregationSelect(
                  nestedArgs.select.aggregations,
                  relationInfo
                );
              }
            }

            if (nestedArgs.where) {
              subqueryWhere = this.visitWhereArray(nestedArgs.where);
            }

            if (nestedArgs.orderBy) {
              subqueryOrderBy = this.visitOrderByArray(nestedArgs.orderBy);
            }

            if (nestedArgs.take || nestedArgs.skip) {
              subqueryLimit = this.adapter.buildLimitOffset(
                nestedArgs.take,
                nestedArgs.skip
              );
            }

            // Handle nested aggregations that might be mixed with regular selection
            if (nestedArgs.data && Array.isArray(nestedArgs.data)) {
              // Check if any of the data contains aggregation operations
              const hasAggregations = nestedArgs.data.some((data: any) =>
                data.fields?.some(
                  (field: any) =>
                    field.operation &&
                    ["_count", "_avg", "_sum", "_min", "_max"].includes(
                      field.operation
                    )
                )
              );

              if (hasAggregations) {
                // Build aggregation select for mixed scenarios
                const aggFields: AggregationFieldAST[] = [];
                nestedArgs.data.forEach((data: any) => {
                  data.fields?.forEach((field: any) => {
                    if (
                      field.operation &&
                      ["_count", "_avg", "_sum", "_min", "_max"].includes(
                        field.operation
                      )
                    ) {
                      aggFields.push({
                        type: "AGGREGATION_FIELD",
                        operation: field.operation,
                        field: field.target?.field,
                        alias: field.alias,
                      });
                    }
                  });
                });

                if (aggFields.length > 0) {
                  const aggSelect = this.buildNestedAggregationSelect(
                    aggFields,
                    relationInfo
                  );
                  subquerySelect =
                    subquerySelect === "*"
                      ? aggSelect
                      : `${subquerySelect}, ${aggSelect}`;
                }
              }
            }
          }

          const subquery = this.adapter.buildNestedRelationSubquery(
            relationInfo,
            subquerySelect,
            subqueryWhere,
            subqueryOrderBy,
            subqueryLimit
          );

          const relationField = this.adapter.buildRelationFieldSelect(
            relationInfo,
            subquery,
            field.nested.relation.name
          );

          fields.push(relationField);
        }
      });

      return this.adapter.buildSelectClause(fields);
    } else {
      // Handle aggregation
      return this.visitAggregation(selection);
    }
  }

  private visitAggregation(aggregation: AggregationAST): string {
    const aggregationStrings = aggregation.aggregations.map((agg) => {
      const field = agg.field
        ? this.adapter.formatIdentifier(agg.field.name)
        : undefined;
      return this.buildAggregationOperation(agg.operation, field);
    });

    return aggregationStrings.join(", ");
  }

  private buildAggregationOperation(operation: string, field?: string): string {
    switch (operation) {
      case "_count":
        return field ? `COUNT(${field})` : `COUNT(*)`;
      case "_avg":
        if (!field) throw new Error("_avg requires a field");
        return `AVG(${field})`;
      case "_sum":
        if (!field) throw new Error("_sum requires a field");
        return `SUM(${field})`;
      case "_min":
        if (!field) throw new Error("_min requires a field");
        return `MIN(${field})`;
      case "_max":
        if (!field) throw new Error("_max requires a field");
        return `MAX(${field})`;
      default:
        throw new Error(`Unknown aggregation operation: ${operation}`);
    }
  }

  // Enhanced method to handle aggregations within relation contexts
  private buildNestedAggregationSelect(
    aggregations: AggregationFieldAST[],
    relationInfo: RelationInfo
  ): string {
    const aggSelects = aggregations.map((agg) => {
      const operation = this.buildAggregationOperation(
        agg.operation,
        agg.field ? this.adapter.formatIdentifier(agg.field.name) : undefined
      );

      return {
        key: agg.alias || agg.operation,
        value: operation,
      };
    });

    return this.adapter.buildJsonObject(aggSelects);
  }

  private visitOrderByArray(orderings: OrderingAST[]): string {
    const orderingStrings = orderings.map((ordering) =>
      this.visitOrdering(ordering)
    );
    return this.adapter.buildOrderByClause(orderingStrings);
  }

  private visitOrdering(ordering: OrderingAST): string {
    let field: string;

    switch (ordering.target.type) {
      case "FIELD":
        const fieldTarget = ordering.target as FieldOrderingTarget;
        field = this.adapter.formatIdentifier(fieldTarget.field.name);
        break;
      case "AGGREGATE":
        const aggTarget = ordering.target as AggregateOrderingTarget;
        const aggField = aggTarget.field
          ? this.adapter.formatIdentifier(aggTarget.field.name)
          : undefined;
        field = this.buildAggregationOperation(aggTarget.operation, aggField);
        break;
      case "RELATION":
        const relTarget = ordering.target as RelationOrderingTarget;
        // For now, just use the relation name - this would need more sophisticated handling
        field = this.adapter.formatIdentifier(relTarget.relation.name);
        break;
      default:
        throw new Error(
          `Unknown ordering target type: ${(ordering.target as any).type}`
        );
    }

    let result = `${field} ${ordering.direction.toUpperCase()}`;

    if (ordering.nulls) {
      result += ` NULLS ${ordering.nulls.toUpperCase()}`;
    }

    return result;
  }

  private visitGroupByArray(groupBy: GroupByAST[]): string {
    const fields = groupBy.map((gb) =>
      this.adapter.formatIdentifier(gb.field.name)
    );
    return this.adapter.buildGroupByClause(fields);
  }

  private visitCursor(cursor: CursorAST): string {
    const field = this.adapter.formatIdentifier(cursor.field.name);
    const value = this.visitValue(cursor.value);
    return this.adapter.buildCursorPagination(
      field,
      value,
      cursor.direction || "forward"
    );
  }

  private visitIncludes(
    inclusion: InclusionAST,
    sourceModel: ModelReference
  ): string {
    // Generate JSON subqueries for each included relation
    const relationSelects = inclusion.relations.map((relation) => {
      const relationInfo: RelationInfo = {
        sourceTable: sourceModel.name,
        targetTable: relation.relation.targetModel.name,
        relationName: relation.relation.name,
        relationType: this.determineRelationType(relation.relation),
      };

      // Build the subquery for this relation
      let subquerySelect = "*"; // Default to all fields
      let subqueryWhere: string | undefined;
      let subqueryOrderBy: string | undefined;
      let subqueryLimit: string | undefined;

      // Handle nested selection if present
      if (relation.nested?.args) {
        const nestedArgs = relation.nested.args;

        // Handle nested select
        if (nestedArgs.select) {
          subquerySelect = this.visitSelect(nestedArgs.select);
        }

        // Handle nested where
        if (nestedArgs.where) {
          subqueryWhere = this.visitWhereArray(nestedArgs.where);
        }

        // Handle nested orderBy
        if (nestedArgs.orderBy) {
          subqueryOrderBy = this.visitOrderByArray(nestedArgs.orderBy);
        }

        // Handle nested limit/skip
        if (nestedArgs.take || nestedArgs.skip) {
          subqueryLimit = this.adapter.buildLimitOffset(
            nestedArgs.take,
            nestedArgs.skip
          );
        }
      }

      // Build the subquery
      const subquery = this.adapter.buildNestedRelationSubquery(
        relationInfo,
        subquerySelect,
        subqueryWhere,
        subqueryOrderBy,
        subqueryLimit
      );

      // Return the relation field select with JSON aggregation
      return this.adapter.buildRelationFieldSelect(
        relationInfo,
        subquery,
        relation.relation.name
      );
    });

    return relationSelects.join(", ");
  }

  private determineRelationType(
    relation: any
  ): "one-to-one" | "one-to-many" | "many-to-one" | "many-to-many" {
    // TODO: Extract from relation metadata when available
    // For now, default to one-to-many
    return "one-to-many";
  }

  private visitValue(valueAST: ValueAST): string {
    // Handle JSON filter operations
    if (valueAST.valueType === "json" && valueAST.options) {
      return this.buildJsonFilterOperation(valueAST);
    }

    // Handle array filter operations
    if (valueAST.isArray && valueAST.options?.arrayOp) {
      return this.buildArrayFilterOperation(valueAST);
    }

    // Handle array operations with push flag
    if (valueAST.isArray && valueAST.options?.operation === "push") {
      return this.buildArrayPushOperation(valueAST);
    }

    // Handle regular array values
    if (valueAST.isArray && Array.isArray(valueAST.value)) {
      return this.buildArrayValue(valueAST);
    }

    return this.adapter.formatValue(valueAST.value, valueAST.valueType);
  }

  private buildArrayValue(valueAST: ValueAST): string {
    if (!Array.isArray(valueAST.value)) {
      return this.adapter.formatValue(valueAST.value, valueAST.valueType);
    }

    // Format each array element according to the base type
    const formattedValues = (valueAST.value as any[]).map((val) =>
      this.adapter.formatValue(val, valueAST.valueType)
    );

    // Return as SQL array literal (database-specific)
    return `ARRAY[${formattedValues.join(", ")}]`;
  }

  private buildArrayPushOperation(valueAST: ValueAST): string {
    // For push operations, format the value to be pushed
    const value = this.adapter.formatValue(valueAST.value, valueAST.valueType);
    return `JSON_ARRAY_APPEND(field_name, '$', ${value})`; // This will be used in context
  }

  private buildJsonFilterOperation(valueAST: ValueAST): string {
    const options = valueAST.options!;
    const baseValue = this.adapter.formatValue(
      valueAST.value,
      valueAST.valueType
    );

    // Build JSON filter operations based on JsonFilter structure
    if (options.path) {
      const pathStr = options.path.join(".");
      return `JSON_EXTRACT(${baseValue}, '$.${pathStr}')`;
    }

    if (options.string_contains) {
      return `JSON_SEARCH(${baseValue}, 'one', '%${options.string_contains}%')`;
    }

    if (options.string_starts_with) {
      return `JSON_SEARCH(${baseValue}, 'one', '${options.string_starts_with}%')`;
    }

    if (options.string_ends_with) {
      return `JSON_SEARCH(${baseValue}, 'one', '%${options.string_ends_with}')`;
    }

    if (options.array_contains) {
      const containsValue = this.adapter.formatValue(
        options.array_contains,
        "json"
      );
      return `JSON_CONTAINS(${baseValue}, ${containsValue})`;
    }

    if (options.array_starts_with) {
      const startsValue = this.adapter.formatValue(
        options.array_starts_with,
        "json"
      );
      return `JSON_EXTRACT(${baseValue}, '$[0]') = ${startsValue}`;
    }

    if (options.array_ends_with) {
      const endsValue = this.adapter.formatValue(
        options.array_ends_with,
        "json"
      );
      return `JSON_EXTRACT(${baseValue}, '$[last]') = ${endsValue}`;
    }

    return baseValue;
  }

  private buildArrayFilterOperation(valueAST: ValueAST): string {
    const arrayOp = valueAST.options!.arrayOp!;
    const value = this.adapter.formatValue(valueAST.value, valueAST.valueType);

    switch (arrayOp) {
      case "has":
        // Check if array contains the value
        return `${value} = ANY(field_name)`; // Will be used in context with actual field name

      case "hasEvery":
        // Check if array contains all values
        if (Array.isArray(valueAST.value)) {
          const values = (valueAST.value as any[]).map((val) =>
            this.adapter.formatValue(val, valueAST.valueType)
          );
          return `field_name @> ARRAY[${values.join(", ")}]`; // PostgreSQL syntax
        }
        return `field_name @> ${value}`;

      case "hasSome":
        // Check if array contains any of the values
        if (Array.isArray(valueAST.value)) {
          const values = (valueAST.value as any[]).map((val) =>
            this.adapter.formatValue(val, valueAST.valueType)
          );
          return `field_name && ARRAY[${values.join(", ")}]`; // PostgreSQL overlap operator
        }
        return `field_name && ${value}`;

      case "isEmpty":
        // Check if array is empty
        return valueAST.value === true
          ? `array_length(field_name, 1) IS NULL OR array_length(field_name, 1) = 0`
          : `array_length(field_name, 1) > 0`;

      default:
        throw new Error(`Unknown array operation: ${arrayOp}`);
    }
  }

  private visitUpsertQuery(ast: QueryAST): string {
    const table = this.adapter.formatTableName(ast.model.name);

    // Get upsert data from args
    const upsertData = (ast.args as any).upsert;
    if (!upsertData || upsertData.type !== "UPSERT") {
      throw new Error("Upsert query requires upsert data");
    }

    // Build insert fields and values from create data
    const createData = upsertData.createData;
    const insertFields: string[] = [];
    const insertValues: string[] = [];

    for (const field of createData.fields) {
      if (field.target.type === "FIELD" && field.value) {
        insertFields.push(
          this.adapter.formatIdentifier(field.target.field.name)
        );
        insertValues.push(this.visitValue(field.value));
      }
    }

    // Build update clauses from update data
    const updateData = upsertData.updateData;
    const updateClauses: string[] = [];

    for (const field of updateData.fields) {
      if (field.target.type === "FIELD" && field.value) {
        const fieldName = this.adapter.formatIdentifier(
          field.target.field.name
        );
        const value = this.visitValue(field.value);
        updateClauses.push(`${fieldName} = ${value}`);
      }
    }

    // Build conflict target
    const conflictTarget = this.buildConflictTarget(upsertData.conflictTarget);

    // Handle where clause
    let whereClause: string | undefined;
    if (ast.args.where && ast.args.where.length > 0) {
      whereClause = this.visitWhereArray(ast.args.where);
    }

    return this.adapter.buildUpsertQuery(
      table,
      insertFields,
      insertValues,
      conflictTarget,
      updateClauses,
      whereClause
    );
  }

  private buildConflictTarget(conflictTargetAST: any): string {
    const target = conflictTargetAST.target;

    switch (target.type) {
      case "FIELD":
        const fields = target.fields.map((field: any) =>
          this.adapter.formatIdentifier(field.name)
        );
        return `(${fields.join(", ")})`;

      case "INDEX":
        return target.indexName;

      case "CONSTRAINT":
        return `ON CONSTRAINT ${target.constraintName}`;

      default:
        throw new Error(`Unknown conflict target type: ${target.type}`);
    }
  }
}
