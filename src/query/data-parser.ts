// Data Parser for BaseORM
// Handles data operations (create, update, etc.) and converts them to AST

import {
  DataAST,
  DataFieldAST,
  DataTarget,
  DataOperation,
  FieldDataTarget,
  RelationDataTarget,
  ModelReference,
  FieldReference,
  RelationReference,
  ParseError,
} from "./ast";
import { FieldResolver } from "./field-resolver";
import { ValueParser } from "./value-parser";

// ================================
// Type Guards
// ================================

function isFieldReference(
  ref: FieldReference | RelationReference
): ref is FieldReference {
  return "field" in ref;
}

function isRelationReference(
  ref: FieldReference | RelationReference
): ref is RelationReference {
  return "relation" in ref;
}

// ================================
// Data Parser
// ================================

export class DataParser {
  constructor(
    private fieldResolver: FieldResolver,
    private valueParser: ValueParser
  ) {}

  /**
   * Parses data operations from Prisma-like syntax to AST
   */
  parseData(data: any, model: ModelReference): DataAST[] {
    if (!data || typeof data !== "object") {
      throw new ParseError("Invalid data object", { model: model.name });
    }

    const fields: DataFieldAST[] = [];

    for (const [key, value] of Object.entries(data)) {
      try {
        // Check if it's a field or relation
        const resolved = this.fieldResolver.resolveFieldPath(model.name, [key]);

        if (isFieldReference(resolved)) {
          // Check if this is a complex field operation
          if (
            value &&
            typeof value === "object" &&
            !Array.isArray(value) &&
            !(value instanceof Date)
          ) {
            const operations = this.parseFieldOperations(value, resolved);
            fields.push(...operations);
          } else {
            // Regular field assignment
            fields.push({
              type: "DATA_FIELD",
              target: {
                type: "FIELD",
                field: resolved,
              } as FieldDataTarget,
              operation: "set",
              value: this.valueParser.parseValue(value, resolved.field),
            });
          }
        } else if (isRelationReference(resolved)) {
          // Relation operation
          fields.push(this.parseRelationData(key, value, model, resolved));
        }
      } catch (error) {
        if (error instanceof ParseError) {
          throw error;
        }
        throw new ParseError(`Failed to parse data field '${key}': ${error}`, {
          model: model.name,
          field: key,
        });
      }
    }

    return [
      {
        type: "DATA",
        model,
        fields,
      },
    ];
  }

  /**
   * Parses relation data operations (connect, create, etc.)
   */
  private parseRelationData(
    relationName: string,
    value: any,
    model: ModelReference,
    relation: RelationReference
  ): DataFieldAST {
    const target: RelationDataTarget = {
      type: "RELATION",
      relation,
    };

    // Determine operation based on value structure
    if (value && typeof value === "object") {
      if (value.connect) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "connect",
          value: this.valueParser.parseValue(value.connect),
        };
      }

      if (value.create) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "create",
          value: this.valueParser.parseValue(value.create),
        };
      }

      if (value.connectOrCreate) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "connectOrCreate",
          value: this.valueParser.parseValue(value.connectOrCreate),
        };
      }

      if (value.disconnect) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "disconnect",
          value: this.valueParser.parseValue(value.disconnect),
        };
      }

      if (value.delete) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "delete",
          value: this.valueParser.parseValue(value.delete),
        };
      }

      if (value.update) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "update",
          value: this.valueParser.parseValue(value.update),
        };
      }

      if (value.upsert) {
        return {
          type: "DATA_FIELD",
          target,
          operation: "upsert",
          value: this.valueParser.parseValue(value.upsert),
        };
      }
    }

    // Default to connect for simple values
    return {
      type: "DATA_FIELD",
      target,
      operation: "connect",
      value: this.valueParser.parseValue(value),
    };
  }

  /**
   * Parses field operations (set, increment, push, etc.)
   */
  private parseFieldOperations(
    value: any,
    field: FieldReference
  ): DataFieldAST[] {
    const operations: DataFieldAST[] = [];
    const target: FieldDataTarget = {
      type: "FIELD",
      field,
    };

    // Handle different operations
    if (value.set !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "set",
        value: this.valueParser.parseValue(value.set, field.field),
      });
    }

    if (value.increment !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "increment",
        value: this.valueParser.parseValue(value.increment, field.field),
      });
    }

    if (value.decrement !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "decrement",
        value: this.valueParser.parseValue(value.decrement, field.field),
      });
    }

    if (value.multiply !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "multiply",
        value: this.valueParser.parseValue(value.multiply, field.field),
      });
    }

    if (value.divide !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "divide",
        value: this.valueParser.parseValue(value.divide, field.field),
      });
    }

    if (value.push !== undefined) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "push",
        value: this.valueParser.parseValue(value.push, field.field),
      });
    }

    // If no operations found, treat as a set operation
    if (operations.length === 0) {
      operations.push({
        type: "DATA_FIELD",
        target,
        operation: "set",
        value: this.valueParser.parseValue(value, field.field),
      });
    }

    return operations;
  }
}
