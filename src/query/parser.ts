// Query Parser for BaseORM
// Transforms Prisma-like query objects into unified AST structure

import { Model } from "../schema/model";
import {
  Operation,
  OperationPayload,
} from "../types/client/operations/defintion";
import {
  QueryAST,
  QueryArgsAST,
  ConditionAST,
  SelectionAST,
  InclusionAST,
  DataAST,
  BatchDataAST,
  AggregationAST,
  GroupByAST,
  CursorAST,
  OrderingAST,
  SchemaRegistry,
  ModelReference,
  ParseError,
} from "./ast";
import { FieldResolver } from "./field-resolver";
import { ValueParser } from "./value-parser";
import { FilterParser } from "./filter-parser";
import { DataParser } from "./data-parser";
import { SelectionParser } from "./selection-parser";
import { OrderingParser } from "./ordering-parser";
import { AggregationParser } from "./aggregation-parser";
import { BatchParser } from "./batch-parser";
import { CursorParser } from "./cursor-parser";

// ================================
// Core Parser Interface
// ================================

export interface QueryParser {
  registry: SchemaRegistry;
  parse<M extends Model<any>, O extends Operation>(
    model: string,
    operation: O,
    args: OperationPayload<O, M>
  ): QueryAST;
}

// ================================
// Main Query Parser Implementation
// ================================

export class DefaultQueryParser implements QueryParser {
  private fieldResolver: FieldResolver;
  private valueParser: ValueParser;
  private filterParser: FilterParser;
  private dataParser: DataParser;
  private selectionParser: SelectionParser;
  private orderingParser: OrderingParser;
  private aggregationParser: AggregationParser;
  private batchParser: BatchParser;
  private cursorParser: CursorParser;

  constructor(public registry: SchemaRegistry) {
    this.fieldResolver = new FieldResolver(registry);
    this.valueParser = new ValueParser();
    this.filterParser = new FilterParser(this.fieldResolver, this.valueParser);
    this.dataParser = new DataParser(this.fieldResolver, this.valueParser);
    this.selectionParser = new SelectionParser(this.fieldResolver);
    this.orderingParser = new OrderingParser(this.fieldResolver);
    this.aggregationParser = new AggregationParser(this.fieldResolver);
    this.batchParser = new BatchParser(this.dataParser);
    this.cursorParser = new CursorParser(this.fieldResolver, this.valueParser);
  }

  parse<M extends Model<any>, O extends Operation>(
    model: string,
    operation: O,
    args: OperationPayload<O, M>
  ): QueryAST {
    const modelRef = this.registry.createModelReference(model);

    const queryArgs: QueryArgsAST = {
      type: "QUERY_ARGS",
    };

    // Parse different clauses based on what's provided
    if (this.hasWhereClause(args)) {
      queryArgs.where = this.parseWhereClause(args.where, modelRef);
    }

    // Handle data operations (regular or batch)
    if (this.hasDataClause(args)) {
      queryArgs.data = this.parseDataClause(args.data, modelRef);
    } else if (this.hasBatchDataClause(args, operation)) {
      queryArgs.data = this.parseBatchDataClause(args, modelRef, operation);
    }

    // Handle selection (regular or aggregation)
    if (this.hasSelectClause(args)) {
      queryArgs.select = this.parseSelectClause(args.select, modelRef);
    } else if (this.hasAggregateClause(args)) {
      queryArgs.select = this.parseAggregateClause(args, modelRef);
    }

    if (this.hasIncludeClause(args)) {
      queryArgs.include = this.parseIncludeClause(args.include, modelRef);
    }

    if (this.hasOrderByClause(args)) {
      queryArgs.orderBy = this.parseOrderByClause(args.orderBy, modelRef);
    }

    // Handle groupBy
    if (this.hasGroupByClause(args)) {
      queryArgs.groupBy = this.parseGroupByClause(args.groupBy, modelRef);
    }

    // Handle having (similar to where but for grouped results)
    if (this.hasHavingClause(args)) {
      queryArgs.having = this.parseHavingClause(args.having, modelRef);
    }

    // Handle cursor-based pagination
    if (this.hasCursorClause(args)) {
      queryArgs.cursor = this.parseCursorClause(args.cursor, modelRef);
    }

    // Handle other standard query arguments
    if ((args as any).take !== undefined) {
      queryArgs.take = (args as any).take;
    }

    if ((args as any).skip !== undefined) {
      queryArgs.skip = (args as any).skip;
    }

    if ((args as any).distinct !== undefined) {
      queryArgs.distinct = (args as any).distinct;
    }

    return {
      type: "QUERY",
      operation,
      model: modelRef,
      args: queryArgs,
    };
  }

  // Type guards for different clause types
  private hasWhereClause(args: any): args is { where: any } {
    return args && typeof args === "object" && "where" in args;
  }

  private hasDataClause(args: any): args is { data: any } {
    return args && typeof args === "object" && "data" in args;
  }

  private hasBatchDataClause(args: any, operation: Operation): boolean {
    if (!args || typeof args !== "object") return false;

    // Check for batch operations
    return (
      operation === "createMany" ||
      operation === "updateMany" ||
      operation === "deleteMany"
    );
  }

  private hasSelectClause(args: any): args is { select: any } {
    return args && typeof args === "object" && "select" in args;
  }

  private hasAggregateClause(args: any): boolean {
    return (
      args &&
      typeof args === "object" &&
      ("aggregate" in args ||
        "_count" in args ||
        "_avg" in args ||
        "_sum" in args ||
        "_min" in args ||
        "_max" in args)
    );
  }

  private hasIncludeClause(args: any): args is { include: any } {
    return args && typeof args === "object" && "include" in args;
  }

  private hasOrderByClause(args: any): args is { orderBy: any } {
    return args && typeof args === "object" && "orderBy" in args;
  }

  private hasGroupByClause(args: any): args is { groupBy: any } {
    return args && typeof args === "object" && "groupBy" in args;
  }

  private hasHavingClause(args: any): args is { having: any } {
    return args && typeof args === "object" && "having" in args;
  }

  private hasCursorClause(args: any): args is { cursor: any } {
    return args && typeof args === "object" && "cursor" in args;
  }

  // Delegate parsing to specialized parsers
  private parseWhereClause(where: any, model: ModelReference): ConditionAST[] {
    return this.filterParser.parseWhere(where, model);
  }

  private parseDataClause(data: any, model: ModelReference): DataAST[] {
    return this.dataParser.parseData(data, model);
  }

  private parseBatchDataClause(
    args: any,
    model: ModelReference,
    operation: Operation
  ): BatchDataAST {
    const batchOp = operation as "createMany" | "updateMany" | "deleteMany";
    return this.batchParser.parseBatchOperation(batchOp, args, model);
  }

  private parseSelectClause(select: any, model: ModelReference): SelectionAST {
    return this.selectionParser.parseSelect(select, model);
  }

  private parseAggregateClause(
    args: any,
    model: ModelReference
  ): AggregationAST {
    // Handle different aggregation formats
    if (args.aggregate) {
      return this.aggregationParser.parseAggregate(args.aggregate, model);
    }

    // Handle direct aggregation operations like { _count: true }
    const aggregateObj: any = {};
    for (const key of ["_count", "_avg", "_sum", "_min", "_max"]) {
      if (args[key]) {
        aggregateObj[key] = args[key];
      }
    }

    return this.aggregationParser.parseAggregate(aggregateObj, model);
  }

  private parseIncludeClause(
    include: any,
    model: ModelReference
  ): InclusionAST {
    return this.selectionParser.parseInclude(include, model);
  }

  private parseOrderByClause(
    orderBy: any,
    model: ModelReference
  ): OrderingAST[] {
    return this.orderingParser.parseOrderBy(orderBy, model);
  }

  private parseGroupByClause(
    groupBy: any,
    model: ModelReference
  ): GroupByAST[] {
    return this.aggregationParser.parseGroupBy(groupBy, model);
  }

  private parseHavingClause(
    having: any,
    model: ModelReference
  ): ConditionAST[] {
    // Having clause uses the same syntax as WHERE, just applied after grouping
    return this.filterParser.parseWhere(having, model);
  }

  private parseCursorClause(cursor: any, model: ModelReference): CursorAST {
    return this.cursorParser.parseCursor(cursor, model);
  }
}

export function createQueryParser(registry: SchemaRegistry): QueryParser {
  return new DefaultQueryParser(registry);
}
