import { Sql, sql } from "../../sql/sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../index";
import {
  FieldNotFoundError,
  InvalidFilterError,
  TypeMismatchError,
  UnsupportedTypeOperationError,
  QueryErrorFactory,
} from "../errors/query-errors";

/**
 * FieldFilterBuilder - Field-Specific Filter Generation Component
 *
 * This component handles the generation of field-specific filter conditions
 * for WHERE clauses. It manages type-specific filtering logic and delegates
 * to the appropriate database adapter filter methods.
 *
 * RESPONSIBILITIES:
 * - Map field types to appropriate filter groups
 * - Validate filter operations against field types
 * - Delegate to database adapter filter implementations
 * - Handle type coercion and validation
 * - Provide consistent error messages
 *
 * SUPPORTED FIELD TYPES:
 * - string: contains, startsWith, endsWith, equals, not, in, notIn, mode
 * - number (int/float/decimal): equals, not, gt, gte, lt, lte, in, notIn
 * - bigint: equals, not, gt, gte, lt, lte, in, notIn
 * - boolean: equals, not
 * - dateTime: equals, not, gt, gte, lt, lte, in, notIn
 * - json: path operations, contains, array operations
 * - enum: equals, not, in, notIn
 *
 * FILTER VALIDATION:
 * - Ensures filter operations are valid for field types
 * - Validates filter values against expected types
 * - Provides helpful error messages for invalid combinations
 * - Handles null values and optional fields
 *
 * ARCHITECTURE:
 * - Implements FieldHandler interface for consistent component behavior
 * - Uses adapter pattern to delegate database-specific filter generation
 * - Maintains field type mappings for extensibility
 * - Supports both simple and complex filter conditions
 */
export class FieldFilterBuilder implements FieldHandler {
  readonly name = "FieldFilterBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Check if this handler can process the given field type
   */
  canHandle(fieldType: string): boolean {
    return this.getFilterGroup(fieldType) !== undefined;
  }

  /**
   * Main entry point for field filter generation
   *
   * @param context - Builder context with field and model information
   * @param condition - Filter condition object (e.g., { equals: "value" })
   * @param fieldName - Name of the field being filtered
   * @returns SQL fragment for the field filter
   */
  handle(context: BuilderContext, condition: any, fieldName: string): Sql {
    return this.applyFieldFilter(context, condition, fieldName);
  }

  /**
   * Apply field-specific filter using adapter's filter system
   *
   * This method handles the core logic of translating filter conditions
   * into SQL fragments by delegating to the appropriate adapter filters.
   */
  private applyFieldFilter(
    ctx: BuilderContext,
    conditions: Record<string, any>,
    fieldName: string
  ): Sql {
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
    if (!fieldType) {
      throw QueryErrorFactory.invalidPayload(
        `Field type missing for '${fieldName}' in model '${ctx.model.name}'`,
        ctx,
        "FieldFilterBuilder"
      );
    }

    // Get the appropriate filter handler based on field type
    const filterGroup = this.getFilterGroup(fieldType);
    if (!filterGroup) {
      throw new UnsupportedTypeOperationError(
        "filtering",
        fieldType,
        ctx,
        "FieldFilterBuilder"
      );
    }

    // Process filter conditions and combine with AND
    const filterParts = Object.entries(conditions).map(([operation, value]) => {
      return this.applyFilterOperation(
        ctx,
        operation,
        value,
        fieldName,
        fieldType,
        filterGroup
      );
    });

    if (filterParts.length === 0) {
      throw new InvalidFilterError(
        fieldName,
        fieldType,
        "No valid filter conditions provided",
        ctx,
        "FieldFilterBuilder"
      );
    }

    // Combine multiple operations with AND
    if (filterParts.length === 1) {
      return filterParts[0]!;
    }

    return sql.join(filterParts, " AND ", "(", ")");
  }

  /**
   * Apply a single filter operation
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
      const availableOperations = Object.keys(filterGroup);
      throw new UnsupportedTypeOperationError(
        `${operation} filter`,
        fieldType,
        ctx,
        "FieldFilterBuilder"
      );
    }

    // Validate the filter value before applying
    this.validateFilterValue(
      fieldType,
      operation,
      value,
      fieldName,
      ctx.model.name
    );

    // Apply the filter through the adapter
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
  private getFilterGroup(fieldType: string): Record<string, any> | undefined {
    const filters = this.adapter.filters as any;

    switch (fieldType) {
      case "string":
        return filters?.string;
      case "int":
      case "float":
      case "decimal":
        return filters?.number;
      case "bigint":
      case "bigInt":
        return filters?.bigint;
      case "boolean":
        return filters?.boolean;
      case "dateTime":
        return filters?.dateTime;
      case "json":
        return filters?.json;
      case "enum":
        return filters?.enum;
      case "uuid":
        // UUID fields typically use string filters
        return filters?.string;
      case "bytes":
      case "blob":
        // Binary fields might have their own filters or use string-like filters
        return filters?.binary || filters?.string;
      default:
        return undefined;
    }
  }

  /**
   * Validate filter values before applying them
   *
   * Ensures that filter values are appropriate for the field type
   * and filter operation combination.
   */
  private validateFilterValue(
    fieldType: string,
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    // Handle null values - most field types support null equality
    if (value === null) {
      if (!["equals", "not", "in", "notIn"].includes(operation)) {
        throw new InvalidFilterError(
          fieldName,
          fieldType,
          `Filter operation '${operation}' does not support null values`,
          undefined,
          "FieldFilterBuilder"
        );
      }
      return;
    }

    // Type-specific validation
    switch (fieldType) {
      case "string":
      case "uuid":
        this.validateStringFilter(operation, value, fieldName, modelName);
        break;

      case "int":
      case "float":
      case "decimal":
        this.validateNumberFilter(operation, value, fieldName, modelName);
        break;

      case "bigint":
      case "bigInt":
        this.validateBigIntFilter(operation, value, fieldName, modelName);
        break;

      case "boolean":
        this.validateBooleanFilter(operation, value, fieldName, modelName);
        break;

      case "dateTime":
        this.validateDateTimeFilter(operation, value, fieldName, modelName);
        break;

      case "json":
        this.validateJsonFilter(operation, value, fieldName, modelName);
        break;

      case "enum":
        this.validateEnumFilter(operation, value, fieldName, modelName);
        break;
    }
  }

  /**
   * Validate string field filter values
   */
  private validateStringFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (
      ["equals", "not", "contains", "startsWith", "endsWith"].includes(
        operation
      )
    ) {
      if (typeof value !== "string") {
        throw new TypeMismatchError(
          "string",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    } else if (["in", "notIn"].includes(operation)) {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === "string" || v === null)
      ) {
        throw new InvalidFilterError(
          fieldName,
          "string",
          `Filter operation '${operation}' requires an array of strings`,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Validate number field filter values
   */
  private validateNumberFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (["equals", "not", "gt", "gte", "lt", "lte"].includes(operation)) {
      if (typeof value !== "number" || !isFinite(value)) {
        throw new TypeMismatchError(
          "finite number",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    } else if (["in", "notIn"].includes(operation)) {
      if (
        !Array.isArray(value) ||
        !value.every(
          (v) => (typeof v === "number" && isFinite(v)) || v === null
        )
      ) {
        throw new InvalidFilterError(
          fieldName,
          "number",
          `Filter operation '${operation}' requires an array of finite numbers`,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Validate bigint field filter values
   */
  private validateBigIntFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (["equals", "not", "gt", "gte", "lt", "lte"].includes(operation)) {
      if (
        typeof value !== "bigint" &&
        typeof value !== "number" &&
        typeof value !== "string"
      ) {
        throw new TypeMismatchError(
          "bigint, number, or string",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    } else if (["in", "notIn"].includes(operation)) {
      if (!Array.isArray(value)) {
        throw new InvalidFilterError(
          fieldName,
          "bigint",
          `Filter operation '${operation}' requires an array`,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Validate boolean field filter values
   */
  private validateBooleanFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (["equals", "not"].includes(operation)) {
      if (typeof value !== "boolean") {
        throw new TypeMismatchError(
          "boolean",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Validate dateTime field filter values
   */
  private validateDateTimeFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (["equals", "not", "gt", "gte", "lt", "lte"].includes(operation)) {
      if (!(value instanceof Date) && typeof value !== "string") {
        throw new TypeMismatchError(
          "Date object or ISO string",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    } else if (["in", "notIn"].includes(operation)) {
      if (!Array.isArray(value)) {
        throw new InvalidFilterError(
          fieldName,
          "dateTime",
          `Filter operation '${operation}' requires an array`,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Validate JSON field filter values
   */
  private validateJsonFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    // JSON filters are more flexible and depend on the specific adapter implementation
    // Basic validation to ensure value is not undefined
    if (value === undefined) {
      throw new InvalidFilterError(
        fieldName,
        "json",
        `Filter operation '${operation}' cannot have undefined value`,
        undefined,
        "FieldFilterBuilder"
      );
    }
  }

  /**
   * Validate enum field filter values
   */
  private validateEnumFilter(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (["equals", "not"].includes(operation)) {
      if (typeof value !== "string") {
        throw new TypeMismatchError(
          "string",
          typeof value,
          fieldName,
          undefined,
          "FieldFilterBuilder"
        );
      }
    } else if (["in", "notIn"].includes(operation)) {
      if (
        !Array.isArray(value) ||
        !value.every((v) => typeof v === "string" || v === null)
      ) {
        throw new InvalidFilterError(
          fieldName,
          "enum",
          `Filter operation '${operation}' requires an array of strings`,
          undefined,
          "FieldFilterBuilder"
        );
      }
    }
  }

  /**
   * Get list of supported field types for error messages
   */
  private getSupportedFieldTypes(): string[] {
    return [
      "string",
      "int",
      "float",
      "decimal",
      "bigint",
      "bigInt",
      "boolean",
      "dateTime",
      "json",
      "enum",
      "uuid",
      "bytes",
      "blob",
    ];
  }

  /**
   * Public method to check if a field type is supported
   */
  public isFieldTypeSupported(fieldType: string): boolean {
    return this.getFilterGroup(fieldType) !== undefined;
  }

  /**
   * Public method to get available operations for a field type
   */
  public getAvailableOperations(fieldType: string): string[] {
    const filterGroup = this.getFilterGroup(fieldType);
    return filterGroup ? Object.keys(filterGroup) : [];
  }
}
