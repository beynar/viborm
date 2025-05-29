// Aggregation Parser for BaseORM
// Handles aggregation operations (count, aggregate, groupBy, having) and converts them to AST

import {
  AggregationAST,
  AggregationFieldAST,
  AggregationOperation,
  GroupByAST,
  ModelReference,
  FieldReference,
  ParseError,
  createAggregation,
  createAggregationField,
  createGroupBy,
} from "./ast";
import { FieldResolver } from "./field-resolver";

// ================================
// Aggregation Parser
// ================================

export class AggregationParser {
  constructor(private fieldResolver: FieldResolver) {}

  /**
   * Parses aggregate() operations from Prisma-like syntax to AST
   */
  parseAggregate(aggregate: any, model: ModelReference): AggregationAST {
    if (!aggregate || typeof aggregate !== "object") {
      throw new ParseError("Invalid aggregate object", { model: model.name });
    }

    const aggregations: AggregationFieldAST[] = [];

    for (const [key, value] of Object.entries(aggregate)) {
      if (this.isAggregationOperation(key)) {
        const operation = key as AggregationOperation;

        if (operation === "_count") {
          // Handle _count operations
          aggregations.push(...this.parseCountOperation(value, model));
        } else {
          // Handle _avg, _sum, _min, _max operations
          aggregations.push(
            ...this.parseFieldAggregationOperation(operation, value, model)
          );
        }
      }
    }

    return createAggregation(model, aggregations);
  }

  /**
   * Parses count() operations
   */
  parseCount(count: any, model: ModelReference): AggregationAST {
    const aggregations: AggregationFieldAST[] = [];

    if (count === true || count === undefined) {
      // Simple count() - count all records
      aggregations.push(createAggregationField("_count"));
    } else if (typeof count === "object" && count !== null) {
      // Count with specific fields or conditions
      aggregations.push(...this.parseCountOperation(count, model));
    } else {
      throw new ParseError("Invalid count operation", { model: model.name });
    }

    return createAggregation(model, aggregations);
  }

  /**
   * Parses groupBy operations from array of field names to AST
   */
  parseGroupBy(groupBy: any, model: ModelReference): GroupByAST[] {
    if (!Array.isArray(groupBy)) {
      throw new ParseError("groupBy must be an array", { model: model.name });
    }

    const groupByFields: GroupByAST[] = [];

    for (const fieldName of groupBy) {
      if (typeof fieldName !== "string") {
        throw new ParseError("groupBy field names must be strings", {
          model: model.name,
        });
      }

      try {
        const fieldRef = this.fieldResolver.resolveField(model.name, fieldName);
        groupByFields.push(createGroupBy(fieldRef));
      } catch (error) {
        if (error instanceof ParseError) {
          throw error;
        }
        throw new ParseError(
          `Failed to resolve groupBy field '${fieldName}': ${error}`,
          {
            model: model.name,
            field: fieldName,
          }
        );
      }
    }

    return groupByFields;
  }

  /**
   * Parses _count operations with specific fields or conditions
   */
  private parseCountOperation(
    count: any,
    model: ModelReference
  ): AggregationFieldAST[] {
    const aggregations: AggregationFieldAST[] = [];

    if (count === true) {
      // Simple count all
      aggregations.push(createAggregationField("_count"));
    } else if (typeof count === "object" && count !== null) {
      for (const [key, value] of Object.entries(count)) {
        if (value === true) {
          try {
            // Count specific field
            const fieldRef = this.fieldResolver.resolveField(model.name, key);
            aggregations.push(createAggregationField("_count", fieldRef));
          } catch (error) {
            // If field doesn't exist, it might be a special count operation
            if (key === "_all") {
              aggregations.push(createAggregationField("_count"));
            } else {
              throw new ParseError(
                `Invalid count field '${key}' in model '${model.name}'`,
                { model: model.name, field: key }
              );
            }
          }
        }
      }
    }

    return aggregations;
  }

  /**
   * Parses field aggregation operations (_avg, _sum, _min, _max)
   */
  private parseFieldAggregationOperation(
    operation: AggregationOperation,
    value: any,
    model: ModelReference
  ): AggregationFieldAST[] {
    if (!value || typeof value !== "object") {
      throw new ParseError(
        `Invalid ${operation} operation: must be an object`,
        { model: model.name, operation }
      );
    }

    const aggregations: AggregationFieldAST[] = [];

    for (const [fieldName, enabled] of Object.entries(value)) {
      if (enabled === true) {
        try {
          const fieldRef = this.fieldResolver.resolveField(
            model.name,
            fieldName
          );
          aggregations.push(createAggregationField(operation, fieldRef));
        } catch (error) {
          if (error instanceof ParseError) {
            throw error;
          }
          throw new ParseError(
            `Failed to resolve ${operation} field '${fieldName}': ${error}`,
            {
              model: model.name,
              field: fieldName,
              operation,
            }
          );
        }
      }
    }

    return aggregations;
  }

  /**
   * Checks if a key represents an aggregation operation
   */
  private isAggregationOperation(key: string): key is AggregationOperation {
    const operations: AggregationOperation[] = [
      "_count",
      "_avg",
      "_sum",
      "_min",
      "_max",
    ];
    return operations.includes(key as AggregationOperation);
  }
}
