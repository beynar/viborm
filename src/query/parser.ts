// Query Parser for BaseORM
// Transforms Prisma-like query objects into unified AST structure

import { Model } from "../schema/model";
import { BaseField } from "../schema/fields/base";
import { Relation } from "../schema/relation";
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
  OrderingAST,
  ValueAST,
  SchemaRegistry,
  ModelReference,
  FieldReference,
  RelationReference,
  BaseOrmValueType,
  ConditionOperator,
  ConditionTarget,
  FieldConditionTarget,
  RelationConditionTarget,
  LogicalConditionTarget,
  DataOperation,
  DataTarget,
  FieldDataTarget,
  RelationDataTarget,
  OrderingTarget,
  FieldOrderingTarget,
  createCondition,
  createValue,
} from "./ast";
import { FilterParser } from "./filter-parser";

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
// Parser Error Types
// ================================

export class ParseError extends Error {
  constructor(
    message: string,
    public context?: {
      model?: string;
      field?: string;
      operation?: string;
      path?: string[];
    }
  ) {
    super(message);
    this.name = "ParseError";
  }
}

// ================================
// Field Resolution
// ================================

export class FieldResolver {
  constructor(private registry: SchemaRegistry) {}

  /**
   * Resolves a field path like "user.profile.bio" to field/relation references
   */
  resolveFieldPath(
    modelName: string,
    fieldPath: string[]
  ): FieldReference | RelationReference {
    if (fieldPath.length === 0) {
      throw new ParseError("Empty field path", { model: modelName });
    }

    let currentModel = this.registry.getModel(modelName);
    if (!currentModel) {
      throw new ParseError(`Model '${modelName}' not found`, {
        model: modelName,
      });
    }

    // Navigate through relations if path has multiple parts
    for (let i = 0; i < fieldPath.length - 1; i++) {
      const relationName = fieldPath[i];
      if (!relationName) {
        throw new ParseError("Invalid field path with empty segment", {
          model: currentModel.name,
          path: fieldPath,
        });
      }

      const relation = currentModel.relations.get(relationName);

      if (!relation) {
        throw new ParseError(
          `Relation '${relationName}' not found in model '${currentModel.name}'`,
          { model: currentModel.name, field: relationName, path: fieldPath }
        );
      }

      currentModel = relation.targetModel;
      if (!currentModel) {
        throw new ParseError(
          `Target model for relation '${relationName}' is not available`,
          { field: relationName, path: fieldPath }
        );
      }
    }

    // Get final field or relation
    const finalName = fieldPath[fieldPath.length - 1];
    if (!finalName) {
      throw new ParseError("Invalid field path with empty final segment", {
        model: currentModel.name,
        path: fieldPath,
      });
    }

    // Try field first
    const field = currentModel.fields.get(finalName);
    if (field) {
      return this.registry.createFieldReference(currentModel.name, finalName);
    }

    // Try relation
    const relation = currentModel.relations.get(finalName);
    if (relation) {
      return this.registry.createRelationReference(
        currentModel.name,
        finalName
      );
    }

    throw new ParseError(
      `Field or relation '${finalName}' not found in model '${currentModel.name}'`,
      { model: currentModel.name, field: finalName, path: fieldPath }
    );
  }

  /**
   * Resolves a simple field name within a model
   */
  resolveField(modelName: string, fieldName: string): FieldReference {
    const field = this.registry.getField(modelName, fieldName);
    if (!field) {
      throw new ParseError(
        `Field '${fieldName}' not found in model '${modelName}'`,
        { model: modelName, field: fieldName }
      );
    }
    return this.registry.createFieldReference(modelName, fieldName);
  }

  /**
   * Resolves a relation name within a model
   */
  resolveRelation(modelName: string, relationName: string): RelationReference {
    const relation = this.registry.getRelation(modelName, relationName);
    if (!relation) {
      throw new ParseError(
        `Relation '${relationName}' not found in model '${modelName}'`,
        { model: modelName, field: relationName }
      );
    }
    return this.registry.createRelationReference(modelName, relationName);
  }
}

// ================================
// Value Parser
// ================================

export class ValueParser {
  /**
   * Parses a value into AST format with proper type inference
   */
  parseValue(value: unknown, field?: BaseField<any>): ValueAST {
    const valueType = this.inferValueType(value, field);
    return createValue(value, valueType);
  }

  /**
   * Infers BaseORM value type from JavaScript value and field context
   */
  private inferValueType(
    value: unknown,
    field?: BaseField<any>
  ): BaseOrmValueType {
    // Handle null explicitly
    if (value === null) {
      return "null";
    }

    // Use field type if available
    if (field) {
      // Map field types to value types
      if (field["~fieldType"] === "string") return "string";
      if (field["~fieldType"] === "int" || field["~fieldType"] === "float")
        return "int";
      if (field["~fieldType"] === "bigInt") return "bigInt";
      if (field["~fieldType"] === "boolean") return "boolean";
      if (field["~fieldType"] === "dateTime") return "dateTime";
      if (field["~fieldType"] === "json") return "json";
      if (field["~fieldType"] === "enum") return "enum";
      if (field["~fieldType"] === "blob") return "blob";
    }

    // Fallback to JavaScript type inference
    if (typeof value === "string") return "string";
    if (typeof value === "boolean") return "boolean";
    if (typeof value === "number") return "int";
    if (typeof value === "bigint") return "bigInt";
    if (value instanceof Date) return "dateTime";
    if (Array.isArray(value)) return "array";

    // Default to JSON for objects
    return "json";
  }
}

// ================================
// Main Parser Implementation
// ================================

export class DefaultQueryParser implements QueryParser {
  private fieldResolver: FieldResolver;
  private valueParser: ValueParser;
  private filterParser: FilterParser;

  constructor(public registry: SchemaRegistry) {
    this.fieldResolver = new FieldResolver(registry);
    this.valueParser = new ValueParser();
    this.filterParser = new FilterParser(this.fieldResolver, this.valueParser);
  }

  /**
   * Main parsing entry point
   */
  parse<M extends Model<any>, O extends Operation>(
    model: string,
    operation: O,
    args: OperationPayload<O, M>
  ): QueryAST {
    const modelRef = this.registry.createModelReference(model);

    const queryArgs: QueryArgsAST = {
      type: "QUERY_ARGS",
    };

    // Parse common arguments based on operation type
    if (this.hasWhereClause(args)) {
      queryArgs.where = this.parseWhereClause(args.where, modelRef);
    }

    if (this.hasDataClause(args)) {
      queryArgs.data = this.parseDataClause(args.data, modelRef);
    }

    if (this.hasSelectClause(args)) {
      queryArgs.select = this.parseSelectClause(args.select, modelRef);
    }

    if (this.hasIncludeClause(args)) {
      queryArgs.include = this.parseIncludeClause(args.include, modelRef);
    }

    if (this.hasOrderByClause(args)) {
      queryArgs.orderBy = this.parseOrderByClause(args.orderBy, modelRef);
    }

    // Parse pagination
    if ("take" in args && args.take !== undefined) {
      queryArgs.take = args.take;
    }
    if ("skip" in args && args.skip !== undefined) {
      queryArgs.skip = args.skip;
    }

    return {
      type: "QUERY",
      operation,
      model: modelRef,
      args: queryArgs,
    };
  }

  // ================================
  // Type Guards for Arguments
  // ================================

  private hasWhereClause(args: any): args is { where: any } {
    return args && typeof args.where === "object";
  }

  private hasDataClause(args: any): args is { data: any } {
    return args && typeof args.data === "object";
  }

  private hasSelectClause(args: any): args is { select: any } {
    return args && typeof args.select === "object";
  }

  private hasIncludeClause(args: any): args is { include: any } {
    return args && typeof args.include === "object";
  }

  private hasOrderByClause(args: any): args is { orderBy: any } {
    return args && args.orderBy !== undefined;
  }

  // ================================
  // Placeholder Methods (to be implemented)
  // ================================

  private parseWhereClause(where: any, model: ModelReference): ConditionAST[] {
    return this.filterParser.parseWhere(where, model);
  }

  private parseDataClause(data: any, model: ModelReference): DataAST[] {
    // TODO: Implement data clause parsing
    throw new Error("parseDataClause not implemented yet");
  }

  private parseSelectClause(select: any, model: ModelReference): SelectionAST {
    // TODO: Implement select clause parsing
    throw new Error("parseSelectClause not implemented yet");
  }

  private parseIncludeClause(
    include: any,
    model: ModelReference
  ): InclusionAST {
    // TODO: Implement include clause parsing
    throw new Error("parseIncludeClause not implemented yet");
  }

  private parseOrderByClause(
    orderBy: any,
    model: ModelReference
  ): OrderingAST[] {
    // TODO: Implement orderBy clause parsing
    throw new Error("parseOrderByClause not implemented yet");
  }
}

// ================================
// Parser Factory
// ================================

export function createQueryParser(registry: SchemaRegistry): QueryParser {
  return new DefaultQueryParser(registry);
}
