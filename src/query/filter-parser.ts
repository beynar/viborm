// Filter Parser for BaseORM
// Handles WHERE clause parsing with complex filtering logic

import { Model } from "../schema/model";
import {
  ConditionAST,
  ConditionOperator,
  ConditionTarget,
  FieldConditionTarget,
  RelationConditionTarget,
  LogicalConditionTarget,
  ModelReference,
  FieldReference,
  RelationReference,
  ValueAST,
  createCondition,
  ParseError,
} from "./ast";
import { FieldResolver } from "./field-resolver";
import { ValueParser } from "./value-parser";

// ================================
// Filter Operation Mappings
// ================================

const FILTER_OPERATORS: Record<string, ConditionOperator> = {
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
  has: "has",
  hasEvery: "hasEvery",
  hasSome: "hasSome",
  isEmpty: "isEmpty",
};

const RELATION_OPERATORS = ["some", "every", "none", "is", "isNot"];

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
      const condition = this.parseFieldOrRelationFilter(key, value, model);
      if (condition) {
        conditions.push(condition);
      }
    }

    return conditions;
  }

  /**
   * Parses individual field or relation filters
   */
  private parseFieldOrRelationFilter(
    key: string,
    value: any,
    model: ModelReference
  ): ConditionAST | null {
    // Handle logical operators
    if (key === "AND" || key === "OR" || key === "NOT") {
      return this.parseLogicalFilter(key, value, model);
    }

    // Try to resolve as field first, then as relation
    let fieldError: unknown;
    try {
      const fieldRef = this.fieldResolver.resolveField(model.name, key);
      return this.parseFieldFilter(fieldRef, value);
    } catch (error) {
      fieldError = error;
    }

    // If field resolution failed, try as relation
    if (
      fieldError instanceof ParseError &&
      fieldError.message.includes("not found")
    ) {
      try {
        const relationRef = this.fieldResolver.resolveRelation(model.name, key);
        return this.parseRelationFilter(relationRef, value);
      } catch (relationError) {
        if (
          relationError instanceof ParseError &&
          relationError.message.includes("not found")
        ) {
          throw new ParseError(
            `Unknown field or relation '${key}' in model '${model.name}'`,
            { model: model.name, field: key }
          );
        }
        throw relationError;
      }
    }

    throw fieldError;
  }

  /**
   * Parses field-specific filters
   */
  private parseFieldFilter(field: FieldReference, value: any): ConditionAST {
    const target: FieldConditionTarget = {
      type: "FIELD",
      field,
    };

    // Handle direct value assignment (e.g., { name: "John" })
    if (typeof value !== "object" || value === null) {
      return createCondition(
        target,
        "equals",
        this.valueParser.parseValue(value, field.field)
      );
    }

    // Handle filter objects (e.g., { age: { gte: 18 } })
    const filterEntries = Object.entries(value);
    if (filterEntries.length === 1) {
      const firstEntry = filterEntries[0];
      if (!firstEntry) {
        throw new ParseError("Invalid filter entry");
      }
      const [operator, operatorValue] = firstEntry;
      const conditionOperator = this.mapOperator(operator);

      // Handle array operators (in, notIn) by creating array of ValueAST
      if (
        (operator === "in" || operator === "notIn") &&
        Array.isArray(operatorValue)
      ) {
        const arrayValues = operatorValue.map((val) =>
          this.valueParser.parseValue(val, field.field)
        );
        return createCondition(target, conditionOperator, arrayValues);
      }

      return createCondition(
        target,
        conditionOperator,
        this.valueParser.parseValue(operatorValue, field.field)
      );
    }

    // Handle multiple operators combined with AND logic
    const conditions: ConditionAST[] = [];
    for (const [operator, operatorValue] of filterEntries) {
      const conditionOperator = this.mapOperator(operator);

      // Handle array operators for multiple conditions too
      if (
        (operator === "in" || operator === "notIn") &&
        Array.isArray(operatorValue)
      ) {
        const arrayValues = operatorValue.map((val) =>
          this.valueParser.parseValue(val, field.field)
        );
        conditions.push(
          createCondition(target, conditionOperator, arrayValues)
        );
      } else {
        conditions.push(
          createCondition(
            target,
            conditionOperator,
            this.valueParser.parseValue(operatorValue, field.field)
          )
        );
      }
    }

    // Combine with AND logic
    return createCondition(
      { type: "LOGICAL", operator: "AND" } as LogicalConditionTarget,
      "equals", // Not used for logical
      undefined,
      { logic: "AND", nested: conditions }
    );
  }

  /**
   * Parses relation-specific filters
   */
  private parseRelationFilter(
    relation: RelationReference,
    value: any
  ): ConditionAST {
    if (!value || typeof value !== "object") {
      throw new ParseError(`Invalid relation filter for '${relation.name}'`, {
        field: relation.name,
      });
    }

    // Handle relation operations (some, every, none, is, isNot)
    for (const [operation, operationValue] of Object.entries(value)) {
      if (RELATION_OPERATORS.includes(operation)) {
        const target: RelationConditionTarget = {
          type: "RELATION",
          relation,
          operation: operation as any,
        };

        // Parse nested conditions for the target model
        const nestedConditions = this.parseWhere(operationValue, {
          name: relation.targetModel.name,
          model: relation.targetModel,
        });

        return createCondition(target, "equals", undefined, {
          nested: nestedConditions,
        });
      }
    }

    throw new ParseError(
      `Invalid relation filter for '${relation.name}': must use 'some', 'every', 'none', 'is', or 'isNot'`,
      { field: relation.name }
    );
  }

  /**
   * Parses logical filters (AND, OR, NOT)
   */
  private parseLogicalFilter(
    operator: string,
    value: any,
    model: ModelReference
  ): ConditionAST {
    const target: LogicalConditionTarget = {
      type: "LOGICAL",
      operator: operator as "AND" | "OR" | "NOT",
    };

    if (operator === "NOT") {
      // NOT expects a single object
      const nestedConditions = this.parseWhere(value, model);
      return createCondition(target, "equals", undefined, {
        logic: "AND",
        negated: true,
        nested: nestedConditions,
      });
    }

    // AND/OR expect an array of conditions
    if (!Array.isArray(value)) {
      throw new ParseError(
        `${operator} operator expects an array of conditions`,
        { operation: operator }
      );
    }

    const nestedConditions: ConditionAST[] = [];
    for (const condition of value) {
      const parsed = this.parseWhere(condition, model);
      nestedConditions.push(...parsed);
    }

    return createCondition(target, "equals", undefined, {
      logic: operator as "AND" | "OR",
      nested: nestedConditions,
    });
  }

  /**
   * Maps string operators to ConditionOperator enum
   */
  private mapOperator(operator: string): ConditionOperator {
    const mapped = FILTER_OPERATORS[operator];
    if (!mapped) {
      throw new ParseError(`Unknown filter operator '${operator}'`, {
        operation: operator,
      });
    }
    return mapped;
  }
}
