// Filter Parser for BaseORM
// Handles WHERE clause parsing from client filters to AST conditions

import { BaseField } from "../schema/fields/base";
import {
  ConditionAST,
  ValueAST,
  ConditionOperator,
  ConditionTarget,
  FieldConditionTarget,
  RelationConditionTarget,
  LogicalConditionTarget,
  ModelReference,
  FieldReference,
  RelationReference,
  createCondition,
} from "./ast";
import { FieldResolver, ValueParser, ParseError } from "./parser";

// ================================
// Filter Parser Implementation
// ================================

export class FilterParser {
  constructor(
    private fieldResolver: FieldResolver,
    private valueParser: ValueParser
  ) {}

  /**
   * Main entry point for parsing WHERE clauses
   */
  parseWhere(where: any, model: ModelReference): ConditionAST[] {
    if (!where || typeof where !== "object") {
      return [];
    }

    const conditions: ConditionAST[] = [];

    for (const [key, value] of Object.entries(where)) {
      if (this.isLogicalOperator(key)) {
        conditions.push(...this.parseLogicalOperator(key, value, model));
      } else {
        // Regular field or relation filter
        conditions.push(this.parseFieldOrRelationFilter(key, value, model));
      }
    }

    return conditions;
  }

  /**
   * Check if a key is a logical operator (AND, OR, NOT)
   */
  private isLogicalOperator(key: string): key is "AND" | "OR" | "NOT" {
    return key === "AND" || key === "OR" || key === "NOT";
  }

  /**
   * Parse logical operators (AND, OR, NOT)
   */
  private parseLogicalOperator(
    operator: "AND" | "OR" | "NOT",
    value: any,
    model: ModelReference
  ): ConditionAST[] {
    const target: LogicalConditionTarget = {
      type: "LOGICAL",
      operator,
    };

    if (operator === "NOT") {
      // NOT takes a single condition object
      const nestedConditions = this.parseWhere(value, model);
      return [
        createCondition(target, "equals", undefined, {
          logic: "AND",
          nested: nestedConditions,
          negated: true,
        }),
      ];
    } else {
      // AND/OR can take an array or single object
      const conditions = Array.isArray(value) ? value : [value];
      const nestedConditions: ConditionAST[] = [];

      for (const condition of conditions) {
        nestedConditions.push(...this.parseWhere(condition, model));
      }

      return [
        createCondition(target, "equals", undefined, {
          logic: operator,
          nested: nestedConditions,
        }),
      ];
    }
  }

  /**
   * Parse a field or relation filter
   */
  private parseFieldOrRelationFilter(
    key: string,
    value: any,
    model: ModelReference
  ): ConditionAST {
    try {
      // Try to resolve as field first
      const fieldRef = this.fieldResolver.resolveField(model.name, key);
      return this.parseFieldFilter(fieldRef, value);
    } catch (fieldError) {
      // If field resolution failed, try as relation
      if (
        fieldError instanceof ParseError &&
        fieldError.message.includes("not found")
      ) {
        try {
          // Try to resolve as relation
          const relationRef = this.fieldResolver.resolveRelation(
            model.name,
            key
          );
          return this.parseRelationFilter(relationRef, value);
        } catch (relationError) {
          // If relation resolution failed, throw the original "not found" error
          if (
            relationError instanceof ParseError &&
            relationError.message.includes("not found")
          ) {
            throw new ParseError(
              `Unknown field or relation '${key}' in model '${model.name}'`,
              { model: model.name, field: key }
            );
          }
          // If relation parsing failed (but relation exists), re-throw that error
          throw relationError;
        }
      }
      // If it's not a "not found" error, re-throw it
      throw fieldError;
    }
  }

  /**
   * Parse a field filter (scalar value or filter object)
   */
  private parseFieldFilter(field: FieldReference, value: any): ConditionAST {
    const target: FieldConditionTarget = {
      type: "FIELD",
      field,
    };

    // Handle direct value assignment (e.g., { name: "John" })
    if (!this.isFilterObject(value)) {
      const valueAST = this.valueParser.parseValue(value, field.field);
      return createCondition(target, "equals", valueAST);
    }

    // Handle filter object (e.g., { name: { contains: "Jo" } })
    return this.parseFilterObject(target, value, field.field);
  }

  /**
   * Parse a relation filter
   */
  private parseRelationFilter(
    relation: RelationReference,
    value: any
  ): ConditionAST {
    // Relation filters must be objects with relation operations
    if (!value || typeof value !== "object") {
      throw new ParseError(
        `Invalid relation filter for '${relation.name}'. Expected object with relation operations.`,
        { field: relation.name }
      );
    }

    const conditions: ConditionAST[] = [];

    for (const [operation, filterValue] of Object.entries(value)) {
      if (this.isRelationOperation(operation)) {
        const target: RelationConditionTarget = {
          type: "RELATION",
          relation,
          operation,
        };

        // Parse nested conditions for the target model
        const nestedConditions = this.parseWhere(filterValue, {
          name: relation.targetModel.name,
          model: relation.targetModel,
        });

        conditions.push(
          createCondition(target, "equals", undefined, {
            nested: nestedConditions,
          })
        );
      } else {
        throw new ParseError(
          `Invalid relation operation '${operation}' for relation '${relation.name}'`,
          { field: relation.name, operation }
        );
      }
    }

    return this.combineConditions(conditions, "AND");
  }

  /**
   * Check if a value is a filter object (has filter operators)
   */
  private isFilterObject(value: any): boolean {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return false;
    }

    const filterOperators = [
      "equals",
      "not",
      "in",
      "notIn",
      "lt",
      "lte",
      "gt",
      "gte",
      "contains",
      "startsWith",
      "endsWith",
      "mode",
      // JSON operators
      "path",
      "string_contains",
      "string_starts_with",
      "string_ends_with",
      "array_contains",
      "array_starts_with",
      "array_ends_with",
      // List operators
      "has",
      "hasEvery",
      "hasSome",
      "isEmpty",
    ];

    return Object.keys(value).some((key) => filterOperators.includes(key));
  }

  /**
   * Check if a string is a valid relation operation
   */
  private isRelationOperation(
    operation: string
  ): operation is "some" | "every" | "none" | "is" | "isNot" {
    return ["some", "every", "none", "is", "isNot"].includes(operation);
  }

  /**
   * Parse a filter object into conditions
   */
  private parseFilterObject(
    target: FieldConditionTarget,
    filterObj: any,
    field: BaseField<any>
  ): ConditionAST {
    const conditions: ConditionAST[] = [];

    for (const [operator, value] of Object.entries(filterObj)) {
      const astOperator = this.mapFilterOperatorToAST(operator);
      if (!astOperator) {
        throw new ParseError(
          `Unknown filter operator '${operator}' for field '${target.field.name}'`,
          { field: target.field.name, operation: operator }
        );
      }

      let valueAST: ValueAST | ValueAST[] | undefined;

      if (value !== undefined) {
        if (Array.isArray(value)) {
          valueAST = value.map((v) => this.valueParser.parseValue(v, field));
        } else {
          valueAST = this.valueParser.parseValue(value, field);
        }
      }

      conditions.push(createCondition(target, astOperator, valueAST));
    }

    return this.combineConditions(conditions, "AND");
  }

  /**
   * Map client filter operators to AST operators
   */
  private mapFilterOperatorToAST(operator: string): ConditionOperator | null {
    const operatorMap: Record<string, ConditionOperator> = {
      equals: "equals",
      not: "not",
      in: "in",
      notIn: "notIn",
      lt: "lt",
      lte: "lte",
      gt: "gt",
      gte: "gte",
      contains: "contains",
      startsWith: "startsWith",
      endsWith: "endsWith",
      // JSON operators
      path: "jsonPath",
      string_contains: "jsonContains",
      string_starts_with: "jsonStartsWith",
      string_ends_with: "jsonEndsWith",
      array_contains: "arrayContains",
      array_starts_with: "arrayStartsWith",
      array_ends_with: "arrayEndsWith",
      // List operators
      has: "has",
      hasEvery: "hasEvery",
      hasSome: "hasSome",
      isEmpty: "isEmpty",
    };

    return operatorMap[operator] || null;
  }

  /**
   * Combine multiple conditions with a logical operator
   */
  private combineConditions(
    conditions: ConditionAST[],
    logic: "AND" | "OR"
  ): ConditionAST {
    if (conditions.length === 0) {
      throw new ParseError("Cannot combine empty conditions array");
    }

    if (conditions.length === 1) {
      return conditions[0]!;
    }

    // Create a logical condition that combines all conditions
    const target: LogicalConditionTarget = {
      type: "LOGICAL",
      operator: logic,
    };

    return createCondition(target, "equals", undefined, {
      logic,
      nested: conditions,
    });
  }
}
