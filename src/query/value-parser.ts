// Value Parser for BaseORM
// Handles value parsing and type inference from JavaScript values to AST

import {
  ValueAST,
  BaseOrmValueType,
  ValueOptionsAST,
  createJsonPathValue,
  createArrayValue,
  ParseError,
} from "./ast";
import { BaseField } from "../schema/fields/base";

// ================================
// Value Parser
// ================================

export class ValueParser {
  /**
   * Parses a value to AST with enhanced support for JSON and array operations
   */
  parseValue(value: unknown, field?: BaseField<any>): ValueAST {
    // Check if this is a filter object
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Date)
    ) {
      const obj = value as any;

      // Check for JSON filter operations (only for JSON fields)
      if (field?.["~fieldType"] === "json" && this.hasJsonFilterOps(obj)) {
        return this.parseJsonFilter(obj, field);
      }

      // Check for array update operations (set, push)
      if (obj.set !== undefined || obj.push !== undefined) {
        return this.parseArrayUpdate(obj, field);
      }

      // Check for array filter operations (has, hasEvery, hasSome, isEmpty)
      if (field?.["~isArray"] && this.hasArrayFilterOps(obj)) {
        return this.parseArrayFilter(obj, field);
      }
    }

    const baseType = this.inferValueType(value, field);
    const isArray = field?.["~isArray"] || false;

    const valueNode: ValueAST = {
      type: "VALUE",
      value,
      valueType: baseType,
    };

    if (isArray) {
      valueNode.isArray = true;
    }

    return valueNode;
  }

  /**
   * Checks if object has JSON filter operations
   */
  private hasJsonFilterOps(obj: any): boolean {
    return !!(
      obj.path ||
      obj.string_contains ||
      obj.string_starts_with ||
      obj.string_ends_with ||
      obj.array_contains ||
      obj.array_starts_with ||
      obj.array_ends_with
    );
  }

  /**
   * Checks if object has array filter operations
   */
  private hasArrayFilterOps(obj: any): boolean {
    return !!(
      obj.has !== undefined ||
      obj.hasEvery !== undefined ||
      obj.hasSome !== undefined ||
      obj.isEmpty !== undefined
    );
  }

  /**
   * Parses array filter operations for array fields (has, hasEvery, hasSome, isEmpty)
   */
  private parseArrayFilter(obj: any, field?: BaseField<any>): ValueAST {
    const baseType = this.getBaseFieldType(field);
    const options: ValueOptionsAST = {};
    let mainValue: unknown;

    if (obj.has !== undefined) {
      mainValue = obj.has;
      options.arrayOp = "has";
    } else if (obj.hasEvery !== undefined) {
      mainValue = obj.hasEvery;
      options.arrayOp = "hasEvery";
    } else if (obj.hasSome !== undefined) {
      mainValue = obj.hasSome;
      options.arrayOp = "hasSome";
    } else if (obj.isEmpty !== undefined) {
      mainValue = obj.isEmpty;
      options.arrayOp = "isEmpty";
    }

    return {
      type: "VALUE",
      value: mainValue,
      valueType: baseType,
      isArray: true,
      options,
    };
  }

  /**
   * Parses JSON filter operations according to JsonFilter structure
   */
  private parseJsonFilter(obj: any, field?: BaseField<any>): ValueAST {
    const options: ValueOptionsAST = {};

    if (obj.path) options.path = obj.path;
    if (obj.string_contains) options.string_contains = obj.string_contains;
    if (obj.string_starts_with)
      options.string_starts_with = obj.string_starts_with;
    if (obj.string_ends_with) options.string_ends_with = obj.string_ends_with;
    if (obj.array_contains) options.array_contains = obj.array_contains;
    if (obj.array_starts_with)
      options.array_starts_with = obj.array_starts_with;
    if (obj.array_ends_with) options.array_ends_with = obj.array_ends_with;

    // The main value is typically from equals or not operations
    const mainValue = obj.equals !== undefined ? obj.equals : obj.not;

    return {
      type: "VALUE",
      value: mainValue,
      valueType: "json",
      options,
    };
  }

  /**
   * Parses array update operations (set, push)
   */
  private parseArrayUpdate(obj: any, field?: BaseField<any>): ValueAST {
    const baseType = this.getBaseFieldType(field);

    if (obj.set !== undefined) {
      return {
        type: "VALUE",
        value: obj.set,
        valueType: baseType,
        isArray: true,
      };
    }

    if (obj.push !== undefined) {
      return {
        type: "VALUE",
        value: obj.push,
        valueType: baseType,
        isArray: true,
        options: {
          operation: "push", // Custom flag for push operations
        },
      };
    }

    throw new ParseError("Invalid array update operation");
  }

  /**
   * Infers BaseORM value type from JavaScript value and field context
   */
  private inferValueType(
    value: unknown,
    field?: BaseField<any>
  ): BaseOrmValueType {
    // Handle null values first
    if (value === null || value === undefined) {
      return "null";
    }

    // Handle primitive types based on JavaScript types
    if (typeof value === "string") {
      return "string";
    }

    if (typeof value === "boolean") {
      return "boolean";
    }

    if (typeof value === "number") {
      // For numbers, default to int unless field specifies float/decimal
      if (field) {
        const fieldType = field["~fieldType"];
        if (
          fieldType === "float" ||
          fieldType === "decimal" ||
          fieldType === "bigInt"
        ) {
          return fieldType;
        }
      }
      return Number.isInteger(value) ? "int" : "float";
    }

    if (typeof value === "bigint") {
      return "bigInt";
    }

    if (value instanceof Date) {
      return "dateTime";
    }

    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
      return "blob";
    }

    // Handle objects (likely JSON)
    if (typeof value === "object" && value !== null) {
      return "json";
    }

    // Fallback to field type if available
    if (field) {
      return this.getBaseFieldType(field);
    }

    // Final fallback
    return "string";
  }

  private getBaseFieldType(field?: BaseField<any>): BaseOrmValueType {
    if (!field || !field["~fieldType"]) {
      return "json";
    }

    return field["~fieldType"] as BaseOrmValueType;
  }
}
