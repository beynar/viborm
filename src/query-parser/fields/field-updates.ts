import { Sql, sql } from "@sql";
import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../index";
import {
  FieldNotFoundError,
  InvalidPayloadError,
  TypeMismatchError,
  UnsupportedTypeOperationError,
  QueryErrorFactory,
} from "../errors/query-errors";

/**
 * FieldUpdateBuilder - Field-Specific Update Operation Component
 *
 * This component handles the generation of field-specific update operations
 * for SET clauses in UPDATE statements. It manages type-specific update logic
 * and delegates to the appropriate database adapter update methods.
 *
 * RESPONSIBILITIES:
 * - Map field types to appropriate update operation groups
 * - Validate update operations against field types
 * - Delegate to database adapter update implementations
 * - Handle type coercion and validation
 * - Process both simple values and complex update operations
 *
 * SUPPORTED FIELD TYPES & OPERATIONS:
 * - string: set
 * - number (int/float/decimal): set, increment, decrement, multiply, divide
 * - bigint: set, increment, decrement, multiply, divide
 * - boolean: set
 * - dateTime: set
 * - json: set
 * - enum: set
 * - array/list: set, push, pull (database-specific)
 *
 * UPDATE OPERATION TYPES:
 * - set: Direct value assignment (field = value)
 * - increment: Add to numeric field (field = field + value)
 * - decrement: Subtract from numeric field (field = field - value)
 * - multiply: Multiply numeric field (field = field * value)
 * - divide: Divide numeric field (field = field / value)
 * - push: Add element(s) to array field
 * - pull: Remove element(s) from array field
 *
 * VALIDATION:
 * - Ensures update operations are valid for field types
 * - Validates update values against expected types
 * - Provides helpful error messages for invalid combinations
 * - Handles null values and optional fields appropriately
 *
 * ARCHITECTURE:
 * - Implements FieldHandler interface for consistent component behavior
 * - Uses adapter pattern to delegate database-specific update generation
 * - Maintains field type mappings for extensibility
 * - Supports both simple values and complex update operation objects
 */
export class FieldUpdateBuilder implements FieldHandler {
  readonly name = "FieldUpdateBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Check if this handler can process the given field type
   */
  canHandle(fieldType: string): boolean {
    return this.getUpdateGroup(fieldType) !== undefined;
  }

  /**
   * Main entry point for field update operation generation
   *
   * @param context - Builder context with field and model information
   * @param updateValue - Update value (simple value or operation object)
   * @param fieldName - Name of the field being updated
   * @returns SQL fragment for the field update operation
   */
  handle(context: BuilderContext, updateValue: any, fieldName: string): Sql {
    return this.applyFieldUpdate(context, updateValue, fieldName);
  }

  /**
   * Apply field-specific update using adapter's update system
   *
   * This method handles the core logic of translating update values/operations
   * into SQL fragments by delegating to the appropriate adapter updates.
   */
  private applyFieldUpdate(
    ctx: BuilderContext,
    updateValue: any,
    fieldName: string
  ): Sql {
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
    if (!fieldType) {
      throw QueryErrorFactory.invalidPayload(
        `Field type missing for '${fieldName}' in model '${ctx.model.name}'`,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    // Get the appropriate update handler based on field type
    const updateGroup = this.getUpdateGroup(fieldType);
    if (!updateGroup) {
      throw new UnsupportedTypeOperationError(
        "update operations",
        fieldType,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    // Handle simple value assignment (most common case)
    if (this.isSimpleValue(updateValue)) {
      return this.handleSimpleValueUpdate(
        ctx,
        updateValue,
        fieldName,
        fieldType,
        updateGroup
      );
    }

    // Handle complex update operations (increment, decrement, etc.)
    if (this.isUpdateOperationObject(updateValue)) {
      return this.handleComplexUpdateOperations(
        ctx,
        updateValue,
        fieldName,
        fieldType,
        updateGroup
      );
    }

    throw new InvalidPayloadError(
      `Invalid update value for field '${fieldName}' on model '${ctx.model.name}'. Expected a simple value or update operation object.`,
      ctx,
      "FieldUpdateBuilder"
    );
  }

  /**
   * Handle simple value updates (direct assignment)
   */
  private handleSimpleValueUpdate(
    ctx: BuilderContext,
    value: any,
    fieldName: string,
    fieldType: string,
    updateGroup: Record<string, any>
  ): Sql {
    // Validate the value against field type
    this.validateUpdateValue(
      fieldType,
      "set",
      value,
      fieldName,
      ctx.model.name
    );

    // Use 'set' operation for simple values
    const setHandler = updateGroup.set;
    if (!setHandler) {
      throw new UnsupportedTypeOperationError(
        "set",
        fieldType,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    try {
      return setHandler(ctx, value);
    } catch (error) {
      throw new InvalidPayloadError(
        `Failed to apply 'set' update on field '${fieldName}' (${fieldType}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        ctx,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Handle complex update operations (increment, decrement, etc.)
   */
  private handleComplexUpdateOperations(
    ctx: BuilderContext,
    updateOperations: Record<string, any>,
    fieldName: string,
    fieldType: string,
    updateGroup: Record<string, any>
  ): Sql {
    const operations = Object.entries(updateOperations);

    if (operations.length === 0) {
      throw new InvalidPayloadError(
        `Update operation object cannot be empty for field '${fieldName}' on model '${ctx.model.name}'`,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    if (operations.length > 1) {
      throw new InvalidPayloadError(
        `Multiple update operations are not allowed on a single field '${fieldName}' in model '${
          ctx.model.name
        }'. Found: ${operations.map(([op]) => op).join(", ")}`,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    const [operation, value] = operations[0]!;

    // Validate the operation is supported for this field type
    const updateHandler = updateGroup[operation];
    if (!updateHandler) {
      const availableOperations = Object.keys(updateGroup);
      throw new UnsupportedTypeOperationError(
        operation,
        fieldType,
        ctx,
        "FieldUpdateBuilder"
      );
    }

    // Validate the value for this operation
    this.validateUpdateValue(
      fieldType,
      operation,
      value,
      fieldName,
      ctx.model.name
    );

    // Apply the update operation through the adapter
    try {
      return updateHandler(ctx, value);
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
   * Check if a value is a simple assignment value
   */
  private isSimpleValue(value: any): boolean {
    // Simple values are primitives, dates, or arrays (not objects with update operations)
    return (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean" ||
      typeof value === "bigint" ||
      value instanceof Date ||
      Array.isArray(value) ||
      (typeof value === "object" && !this.isUpdateOperationObject(value))
    );
  }

  /**
   * Check if a value is an update operation object
   */
  private isUpdateOperationObject(value: any): boolean {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value instanceof Date
    ) {
      return false;
    }

    // Check if the object contains known update operation keys
    const updateOperationKeys = [
      "set",
      "increment",
      "decrement",
      "multiply",
      "divide",
      "push",
      "pull",
    ];
    const keys = Object.keys(value);

    return (
      keys.length > 0 && keys.every((key) => updateOperationKeys.includes(key))
    );
  }

  /**
   * Get update group based on field type
   *
   * Maps field types to their corresponding update implementations
   * in the database adapter.
   */
  private getUpdateGroup(fieldType: string): Record<string, any> | undefined {
    const updates = this.adapter.updates as any;

    switch (fieldType) {
      case "string":
        return updates?.string;
      case "int":
      case "float":
      case "decimal":
        return updates?.number;
      case "bigint":
      case "bigInt": // Schema uses bigInt, but adapter might use bigint
        return updates?.bigint;
      case "boolean":
        return updates?.boolean;
      case "dateTime":
        return updates?.dateTime;
      case "json":
        return updates?.json;
      case "enum":
        return updates?.enum;
      case "uuid":
        // UUID fields typically use string updates
        return updates?.string;
      case "bytes":
      case "blob":
        // Binary fields might have their own updates or use string-like updates
        return updates?.binary || updates?.string;
      case "list":
      case "array":
        return updates?.list;
      default:
        return undefined;
    }
  }

  /**
   * Validate update values before applying them
   *
   * Ensures that update values are appropriate for the field type
   * and update operation combination.
   */
  private validateUpdateValue(
    fieldType: string,
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    // Handle null values - only 'set' operation typically supports null
    if (value === null) {
      if (operation !== "set") {
        throw new InvalidPayloadError(
          `Update operation '${operation}' does not support null values on field '${fieldName}' (${fieldType}) in model '${modelName}'`,
          undefined,
          "FieldUpdateBuilder"
        );
      }
      return;
    }

    // Type-specific validation
    switch (fieldType) {
      case "string":
      case "uuid":
        this.validateStringUpdate(operation, value, fieldName, modelName);
        break;

      case "int":
      case "float":
      case "decimal":
        this.validateNumberUpdate(operation, value, fieldName, modelName);
        break;

      case "bigint":
      case "bigInt":
        this.validateBigIntUpdate(operation, value, fieldName, modelName);
        break;

      case "boolean":
        this.validateBooleanUpdate(operation, value, fieldName, modelName);
        break;

      case "dateTime":
        this.validateDateTimeUpdate(operation, value, fieldName, modelName);
        break;

      case "json":
        this.validateJsonUpdate(operation, value, fieldName, modelName);
        break;

      case "enum":
        this.validateEnumUpdate(operation, value, fieldName, modelName);
        break;

      case "list":
      case "array":
        this.validateArrayUpdate(operation, value, fieldName, modelName);
        break;
    }
  }

  /**
   * Validate string field update values
   */
  private validateStringUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      if (typeof value !== "string") {
        throw new TypeMismatchError(
          "string",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "string",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate number field update values
   */
  private validateNumberUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (
      ["set", "increment", "decrement", "multiply", "divide"].includes(
        operation
      )
    ) {
      if (typeof value !== "number" || !isFinite(value)) {
        throw new TypeMismatchError(
          "finite number",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }

      // Additional validation for division
      if (operation === "divide" && value === 0) {
        throw new InvalidPayloadError(
          `Number update 'divide' cannot use zero as divisor on field '${fieldName}' in model '${modelName}'`,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "number",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate bigint field update values
   */
  private validateBigIntUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (
      ["set", "increment", "decrement", "multiply", "divide"].includes(
        operation
      )
    ) {
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
          "FieldUpdateBuilder"
        );
      }

      // Additional validation for division
      if (
        operation === "divide" &&
        (value === 0 || value === BigInt(0) || value === "0")
      ) {
        throw new InvalidPayloadError(
          `BigInt update 'divide' cannot use zero as divisor on field '${fieldName}' in model '${modelName}'`,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "bigint",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate boolean field update values
   */
  private validateBooleanUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      if (typeof value !== "boolean") {
        throw new TypeMismatchError(
          "boolean",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "boolean",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate dateTime field update values
   */
  private validateDateTimeUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      if (!(value instanceof Date) && typeof value !== "string") {
        throw new TypeMismatchError(
          "Date object or ISO string",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "dateTime",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate JSON field update values
   */
  private validateJsonUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      // JSON fields are flexible - allow any serializable value except undefined
      if (value === undefined) {
        throw new InvalidPayloadError(
          `JSON update '${operation}' cannot have undefined value on field '${fieldName}' in model '${modelName}'`,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "json",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate enum field update values
   */
  private validateEnumUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      if (typeof value !== "string" && typeof value !== "number") {
        throw new TypeMismatchError(
          "string or number",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "enum",
        undefined,
        "FieldUpdateBuilder"
      );
    }
  }

  /**
   * Validate array field update values
   */
  private validateArrayUpdate(
    operation: string,
    value: any,
    fieldName: string,
    modelName: string
  ): void {
    if (operation === "set") {
      if (!Array.isArray(value)) {
        throw new TypeMismatchError(
          "array",
          typeof value,
          fieldName,
          undefined,
          "FieldUpdateBuilder"
        );
      }
    } else if (operation === "push") {
      // Push can accept a single value or array of values
      // No strict validation here as it depends on the array element type
    } else if (operation === "pull") {
      // Pull operation for removing elements
      // No strict validation here as it depends on the array element type
    } else {
      throw new UnsupportedTypeOperationError(
        operation,
        "array",
        undefined,
        "FieldUpdateBuilder"
      );
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
      "list",
      "array",
    ];
  }

  /**
   * Public method to check if a field type is supported
   */
  public isFieldTypeSupported(fieldType: string): boolean {
    return this.getUpdateGroup(fieldType) !== undefined;
  }

  /**
   * Public method to get available operations for a field type
   */
  public getAvailableOperations(fieldType: string): string[] {
    const updateGroup = this.getUpdateGroup(fieldType);
    return updateGroup ? Object.keys(updateGroup) : [];
  }

  /**
   * Public method to check if a value is a valid simple update value
   */
  public isValidSimpleValue(value: any): boolean {
    return this.isSimpleValue(value);
  }

  /**
   * Public method to check if a value is a valid update operation object
   */
  public isValidUpdateOperation(value: any): boolean {
    return this.isUpdateOperationObject(value);
  }
}
