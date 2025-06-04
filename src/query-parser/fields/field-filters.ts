import { Sql, sql } from "@sql";
import { DatabaseAdapter } from "@adapters";
import {
  QueryParser,
  BuilderContext,
  FieldNotFoundError,
  InvalidFilterError,
  UnsupportedTypeOperationError,
} from "@query-parser";
import { Field } from "@schema";
import { filterValidators } from "@types";
import type { ZodMiniType } from "zod/v4-mini";

export class FieldFilterBuilder {
  readonly name = "FieldFilterBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Main entry point for field filter generation
   * This method handles the core logic of validating and transforming filter conditions
   * using Zod schemas, then delegating to the appropriate adapter filters.
   */
  public handle(ctx: BuilderContext, conditions: any, fieldName: string): Sql {
    const field = ctx.field;
    if (!field) {
      throw new FieldNotFoundError(
        fieldName,
        ctx.model.name,
        ctx,
        "FieldFilterBuilder"
      );
    }
    const fieldType = field["~fieldType"];

    const validatedConditions = this.validateFilter(field, conditions, ctx);

    // Handle empty filter objects gracefully - return no-op instead of error
    if (Object.keys(validatedConditions).length === 0) {
      return sql.empty; // No filtering needed
    }

    const filterGroup = this.getFilterGroup(field, ctx);

    // Process validated filter conditions and combine with AND
    const filterParts = Object.entries(validatedConditions).map(
      ([operation, value]) => {
        return this.applyFilterOperation(
          ctx,
          operation,
          value,
          fieldName,
          fieldType,
          filterGroup
        );
      }
    );

    if (filterParts.length === 0) {
      return sql.empty;
    }

    // Combine multiple operations with AND using adapter operators
    if (filterParts.length === 1) {
      return filterParts[0]!;
    }

    return this.adapter.operators.and(ctx, ...filterParts);
  }

  /**
   * Apply a single filter operation (already validated by Zod)
   */
  private applyFilterOperation(
    ctx: BuilderContext,
    operation: string,
    value: any,
    fieldName: string,
    fieldType: string,
    filterGroup: Record<string, any>
  ): Sql {
    const filterHandler = filterGroup[operation];
    if (!filterHandler) {
      throw new UnsupportedTypeOperationError(
        `${operation} filter`,
        fieldType,
        ctx,
        "FieldFilterBuilder"
      );
    }

    // Apply the filter through the adapter (no additional validation needed)
    try {
      const filterResult = filterHandler(ctx, value);
      if (filterResult && filterResult !== sql.empty) {
        return filterResult;
      }
      return sql.empty;
    } catch (error) {
      throw new InvalidFilterError(
        fieldName,
        fieldType,
        `Failed to apply '${operation}' filter: ${
          error instanceof Error ? error.message : String(error)
        }`,
        ctx,
        "FieldFilterBuilder"
      );
    }
  }

  /**
   * Get filter group based on field type
   *
   * Maps field types to their corresponding filter implementations
   * in the database adapter.
   */
  private getFilterGroup(
    field: Field,
    ctx: BuilderContext
  ): Record<string, any> {
    const fieldType = field["~fieldType"];

    // Map numeric field types to the 'number' filter group since adapters
    // only have a single 'number' filter group, not separate int/float/decimal groups

    const filterGroup = this.adapter.filters[fieldType];

    if (!filterGroup) {
      throw new UnsupportedTypeOperationError(
        "filtering",
        fieldType,
        ctx,
        "FieldFilterBuilder"
      );
    }
    return filterGroup;
  }

  private getFilterValidator(field: Field, ctx: BuilderContext): ZodMiniType {
    const fieldType = field["~fieldType"];
    const fieldState = field["~state"];
    const isNullable = fieldState?.IsNullable === true;
    const isArray = fieldState?.IsArray === true;

    switch (fieldType) {
      case "string":
      case "int":
      case "float":
      case "decimal":
      case "bigInt":
      case "boolean":
      case "enum":
      case "dateTime": {
        const validators =
          fieldType === "enum"
            ? filterValidators.enum(field["~state"].enumValues)
            : filterValidators[fieldType];
        if (isArray) {
          return isNullable ? validators.nullableArray : validators.array;
        } else {
          return isNullable ? validators.nullable : validators.base;
        }
      }
      case "json":
        // JSON only has base and nullable variants (no array variants)
        return isNullable
          ? filterValidators.json.nullable
          : filterValidators.json.base;

      default: {
        throw new UnsupportedTypeOperationError(
          "filtering",
          fieldType,
          ctx,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Public method to validate a filter condition for a field
   * Useful for testing and external validation
   */
  public validateFilter(
    field: Field,
    conditions: any,
    ctx: BuilderContext
  ): any {
    const validator = this.getFilterValidator(field, ctx);
    const transformed = validator.safeParse(conditions);
    if (transformed.error) {
      throw new InvalidFilterError(
        "fieldName",
        "fieldType",
        `Invalid filter conditions: ${transformed.error.message}`,
        ctx,
        "FieldFilterBuilder"
      );
    } else {
      return transformed.data;
    }
  }
}
