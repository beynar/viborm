import { Sql, sql } from "@sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../query-parser";
import {
  FieldNotFoundError,
  InvalidPayloadError,
  UnsupportedTypeOperationError,
} from "../errors/query-errors";
import { Field } from "@schema";
import { dataInputValidators } from "@types";
import type { ZodMiniType } from "zod/v4-mini";

/**
 * FieldUpdateBuilder - Field-Specific Update Operation Component
 *
 * This component handles the generation of field-specific update operations
 * for SET clauses in UPDATE statements using Zod validation and database
 * adapter delegation.
 *
 * RESPONSIBILITIES:
 * - Validate update operations using Zod schemas
 * - Transform raw values and complex update operations
 * - Delegate to database adapter update implementations
 * - Handle automatic raw value to set operation transformation
 *
 * SUPPORTED FIELD TYPES:
 * - string: set
 * - number (int/float/decimal): set, increment, decrement, multiply, divide
 * - bigint: set, increment, decrement, multiply, divide
 * - boolean: set
 * - dateTime: set
 * - json: set, merge, path
 * - enum: set
 *
 * ARCHITECTURE:
 * - Uses Zod schemas for validation and transformation
 * - Maintains field type mappings for database adapter compatibility
 * - Supports both simple values and complex update operation objects
 */
export class FieldUpdateBuilder implements FieldHandler {
  readonly name = "FieldUpdateBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Main entry point for field update operation generation
   */
  public handle(ctx: BuilderContext, updateValue: any, fieldName: string): Sql {
    const field = ctx.field;
    if (!field) {
      throw new FieldNotFoundError(
        fieldName,
        ctx.model.name,
        ctx,
        "FieldUpdateBuilder"
      );
    }
    const fieldType = field["~fieldType"];

    const validatedUpdate = this.validateUpdate(field, updateValue, ctx);
    const updateGroup = this.getUpdateGroup(field, ctx);

    // Process validated update operations and apply them
    const updateEntries = Object.entries(validatedUpdate);

    if (updateEntries.length !== 1) {
      throw new InvalidPayloadError(
        `Expected exactly one update operation, got ${updateEntries.length}`,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    const [operation, value] = updateEntries[0]!;
    return this.applyUpdateOperation(
      ctx,
      operation,
      value,
      fieldName,
      fieldType,
      updateGroup
    );
  }

  /**
   * Apply a single update operation (already validated by Zod)
   */
  private applyUpdateOperation(
    ctx: BuilderContext,
    operation: string,
    value: any,
    fieldName: string,
    fieldType: string,
    updateGroup: Record<string, any>
  ): Sql {
    const updateHandler = updateGroup[operation];
    if (!updateHandler) {
      throw new UnsupportedTypeOperationError(
        `${operation} update`,
        fieldType,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    try {
      const updateResult = updateHandler(ctx, value);
      if (updateResult && updateResult !== sql.empty) {
        return updateResult;
      }
      return sql.empty;
    } catch (error) {
      throw new InvalidPayloadError(
        `Failed to apply '${operation}' update on field '${fieldName}' (${fieldType}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        ctx,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Get the appropriate Zod validator for a field's update operations
   */
  private getUpdateValidator(field: Field, ctx: BuilderContext): ZodMiniType {
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
            ? dataInputValidators.enum(field["~state"].enumValues)
            : dataInputValidators[fieldType];

        if (isArray) {
          return isNullable ? validators.nullableArray : validators.array;
        } else {
          return isNullable ? validators.nullable : validators.base;
        }
      }
      case "json":
        // JSON only has base and nullable variants (no array variants)
        return isNullable
          ? dataInputValidators.json.nullable
          : dataInputValidators.json.base;

      default: {
        throw new UnsupportedTypeOperationError(
          "update operations",
          fieldType,
          ctx,
          "FieldUpdateBuilder"
        );
      }
    }
  }

  /**
   * Get update group based on field type
   */
  private getUpdateGroup(
    field: Field,
    ctx: BuilderContext
  ): Record<string, any> {
    const fieldType = field["~fieldType"];
    const updates = this.adapter.updates;

    // Use the specific field type directly since the adapter has separate
    // update groups for int, float, decimal (unlike filters which only have 'number')
    const updateGroup = (updates as any)[fieldType];
    if (!updateGroup) {
      throw new UnsupportedTypeOperationError(
        "update operations",
        fieldType,
        ctx,
        "FieldUpdateBuilder"
      );
    }
    return updateGroup;
  }

  /**
   * Public method to validate an update operation for a field
   * Useful for testing and external validation
   */
  public validateUpdate(
    field: Field,
    updateValue: any,
    ctx: BuilderContext
  ): any {
    const validator = this.getUpdateValidator(field, ctx);
    const transformed = validator.safeParse(updateValue);
    if (transformed.error) {
      throw new InvalidPayloadError(
        `Invalid update operation: ${
          transformed.error.message || "validation failed"
        }`,
        ctx,
        "FieldUpdateBuilder"
      );
    } else {
      return transformed.data;
    }
  }

  /**
   * Check if this handler can process the given field type
   */
  canHandle(fieldType: string): boolean {
    try {
      const mockField = { "~fieldType": fieldType } as Field;
      const mockCtx = {} as BuilderContext;
      this.getUpdateGroup(mockField, mockCtx);
      return true;
    } catch {
      return false;
    }
  }
}
