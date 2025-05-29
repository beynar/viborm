// Value Parser for BaseORM
// Handles value parsing and type inference from JavaScript values to AST

import { BaseField } from "../schema/fields/base";
import { ValueAST, BaseOrmValueType, createValue, ParseError } from "./ast";

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
    // Handle null values
    if (value === null || value === undefined) {
      return "null";
    }

    // If field context is available, use its type information
    if (field) {
      const fieldType = (field as any).fieldType;
      switch (fieldType) {
        case "string":
          return "string";
        case "boolean":
          return "boolean";
        case "int":
          return "int";
        case "bigInt":
          return "bigInt";
        case "float":
          return "float";
        case "decimal":
          return "decimal";
        case "dateTime":
          return "dateTime";
        case "json":
          return "json";
        case "blob":
          return "blob";
        case "vector":
          return "vector";
        case "enum":
          return "enum";
        default:
          // Fall back to JavaScript type inference
          break;
      }
    }

    // JavaScript type inference
    switch (typeof value) {
      case "string":
        return "string";
      case "boolean":
        return "boolean";
      case "number":
        return Number.isInteger(value) ? "int" : "float";
      case "bigint":
        return "bigInt";
      case "object":
        if (value instanceof Date) {
          return "dateTime";
        }
        if (Array.isArray(value)) {
          return "array";
        }
        // For other objects, treat as JSON
        return "json";
      default:
        throw new ParseError(
          `Unable to infer type for value: ${String(value)} (${typeof value})`
        );
    }
  }
}
