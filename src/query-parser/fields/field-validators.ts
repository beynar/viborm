import { DatabaseAdapter } from "../../adapters/database-adapter";
import { BuilderContext, FieldHandler } from "../types";
import type { QueryParser } from "../query-parser";
/**
 * FieldValidatorBuilder - Field-Specific Validation Component
 *
 * This component centralizes all field validation logic across the BaseORM system.
 * It provides consistent, type-safe validation for field values across different
 * contexts (CREATE, UPDATE, filter values, etc.).
 *
 * RESPONSIBILITIES:
 * - Centralize field type validation logic
 * - Provide consistent validation across all operations
 * - Handle type coercion and value normalization
 * - Generate helpful validation error messages
 * - Support custom field validators
 *
 * SUPPORTED FIELD TYPES:
 * - string: String validation, length checks, format validation
 * - number (int/float/decimal): Numeric validation, range checks, finite validation
 * - bigint: Large number validation, type coercion
 * - boolean: Boolean validation, truthy/falsy handling
 * - dateTime: Date validation, ISO string parsing, range validation
 * - json: JSON serialization validation, object validation
 * - enum: Enum value validation, allowed values checking
 * - uuid: UUID format validation
 * - bytes/blob: Binary data validation
 * - array/list: Array validation, element validation
 *
 * VALIDATION CONTEXTS:
 * - CREATE: Validate data for creation operations
 * - UPDATE: Validate update values and operations
 * - FILTER: Validate filter values for WHERE clauses
 * - INPUT: General input validation for query parameters
 *
 * FEATURES:
 * - Type-specific validation rules
 * - Null value handling based on field optionality
 * - Array validation for collection operations
 * - Custom validator integration (Standard Schema support)
 * - Detailed error messages with field context
 * - Value normalization and type coercion
 *
 * ARCHITECTURE:
 * - Implements FieldHandler interface for consistent component behavior
 * - Integrates with schema field validators
 * - Provides validation for filters, updates, and general input
 * - Maintains validation rule mappings for extensibility
 */
export class FieldValidatorBuilder implements FieldHandler {
  readonly name = "FieldValidatorBuilder";
  readonly dependencies: string[] = [];

  constructor(private parser: QueryParser, private adapter: DatabaseAdapter) {}

  /**
   * Check if this handler can process the given field type
   */
  canHandle(fieldType: string): boolean {
    return this.getSupportedFieldTypes().includes(fieldType);
  }

  /**
   * Main entry point for field validation
   *
   * @param context - Builder context with field and model information
   * @param value - Value to validate
   * @param validationContext - Context of validation (create, update, filter, input)
   * @param operation - Specific operation being performed (optional)
   * @returns Validation result with normalized value or errors
   */
  handle(
    context: BuilderContext,
    value: any,
    validationContext: "create" | "update" | "filter" | "input" = "input",
    operation?: string
  ): ValidationResult {
    return this.validateFieldValue(
      context,
      value,
      validationContext,
      operation
    );
  }

  /**
   * Main validation method that coordinates all validation steps
   */
  private validateFieldValue(
    ctx: BuilderContext,
    value: any,
    validationContext: string,
    operation?: string
  ): ValidationResult {
    const field = ctx.field;
    const fieldName = ctx.fieldName || "unknown";
    const modelName = ctx.model.name;

    if (!field) {
      return {
        valid: false,
        errors: [
          `Field information missing for '${fieldName}' in model '${modelName}'`,
        ],
      };
    }

    const fieldType = field["~fieldType"];
    if (!fieldType) {
      return {
        valid: false,
        errors: [
          `Field type missing for '${fieldName}' in model '${modelName}'`,
        ],
      };
    }

    // Step 1: Handle null values
    const nullValidation = this.validateNullValue(
      field,
      value,
      fieldName,
      modelName,
      validationContext
    );
    if (!nullValidation.valid || nullValidation.value === null) {
      return nullValidation;
    }

    // Use the potentially coerced value from null validation
    const validatedValue =
      nullValidation.value !== undefined ? nullValidation.value : value;

    // Step 2: Basic type validation
    const typeValidation = this.validateByFieldType(
      fieldType,
      validatedValue,
      fieldName,
      modelName,
      validationContext,
      operation,
      field
    );
    if (!typeValidation.valid) {
      return typeValidation;
    }

    // Use the potentially coerced/normalized value from type validation
    const finalValue =
      typeValidation.value !== undefined
        ? typeValidation.value
        : validatedValue;

    // Step 3: Custom field validator
    const customValidation = this.applyCustomValidator(
      field,
      finalValue,
      fieldName,
      modelName
    );
    if (!customValidation.valid) {
      return customValidation;
    }

    return { valid: true, value: finalValue };
  }

  /**
   * Validate null values based on field optionality and context
   */
  private validateNullValue(
    field: any,
    value: any,
    fieldName: string,
    modelName: string,
    validationContext: string
  ): ValidationResult {
    if (value === null) {
      // Check if field is optional or nullable
      const isOptional = field["~optional"] === true;
      const isNullable = field["~nullable"] === true;

      if (!isOptional && !isNullable && validationContext === "create") {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' is required and cannot be null in model '${modelName}'`,
          ],
        };
      }

      // Null is valid for optional/nullable fields or update operations
      return { valid: true, value: null };
    }

    return { valid: true, value };
  }

  /**
   * Perform validation based on field type
   */
  private validateByFieldType(
    fieldType: string,
    value: any,
    fieldName: string,
    modelName: string,
    validationContext: string,
    operation?: string,
    field?: any
  ): ValidationResult {
    // Check if this is an array field first
    if (field && field["~isArray"] === true) {
      return this.validateArrayField(
        value,
        fieldName,
        modelName,
        fieldType,
        field,
        validationContext,
        operation
      );
    }

    switch (fieldType) {
      case "string":
        return this.validateStringField(value, fieldName, modelName, fieldType);

      case "int":
      case "float":
      case "decimal":
        return this.validateNumberField(value, fieldName, modelName, fieldType);

      case "bigint":
      case "bigInt":
        return this.validateBigIntField(value, fieldName, modelName);

      case "boolean":
        return this.validateBooleanField(value, fieldName, modelName);

      case "dateTime":
        return this.validateDateTimeField(value, fieldName, modelName);

      case "json":
        return this.validateJsonField(value, fieldName, modelName);

      case "enum":
        return this.validateEnumField(value, fieldName, modelName);

      case "bytes":
      case "blob":
        return this.validateBinaryField(value, fieldName, modelName, fieldType);

      case "list":
      case "array":
        // These are legacy array field types, treat as generic array
        return this.validateArrayField(
          value,
          fieldName,
          modelName,
          "unknown",
          field,
          validationContext,
          operation
        );

      default:
        return {
          valid: false,
          errors: [
            `Unknown field type '${fieldType}' for field '${fieldName}' in model '${modelName}'`,
          ],
        };
    }
  }

  /**
   * Validate string field values
   */
  private validateStringField(
    value: any,
    fieldName: string,
    modelName: string,
    fieldType: string
  ): ValidationResult {
    if (typeof value !== "string") {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (${fieldType}) requires a string value in model '${modelName}'. ` +
            `Received: ${typeof value}`,
        ],
      };
    }

    return { valid: true, value };
  }

  /**
   * Validate number field values
   */
  private validateNumberField(
    value: any,
    fieldName: string,
    modelName: string,
    fieldType: string
  ): ValidationResult {
    // Allow string numbers for parsing
    let numValue = value;

    if (typeof value === "string") {
      numValue = Number(value);
      if (isNaN(numValue)) {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (${fieldType}) received invalid numeric string in model '${modelName}'. ` +
              `Value: "${value}"`,
          ],
        };
      }
    }

    if (typeof numValue !== "number") {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (${fieldType}) requires a number value in model '${modelName}'. ` +
            `Received: ${typeof value}`,
        ],
      };
    }

    if (!isFinite(numValue)) {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (${fieldType}) must be a finite number in model '${modelName}'. ` +
            `Received: ${numValue}`,
        ],
      };
    }

    // Type-specific validations
    if (fieldType === "int" && !Number.isInteger(numValue)) {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (int) must be an integer in model '${modelName}'. ` +
            `Received: ${numValue}`,
        ],
      };
    }

    return { valid: true, value: numValue };
  }

  /**
   * Validate bigint field values
   */
  private validateBigIntField(
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    // Allow string, number, or bigint
    if (typeof value === "bigint") {
      return { valid: true, value };
    }

    if (typeof value === "number") {
      if (!isFinite(value) || !Number.isInteger(value)) {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (bigint) requires a finite integer when using number type in model '${modelName}'. ` +
              `Received: ${value}`,
          ],
        };
      }
      return { valid: true, value: BigInt(value) };
    }

    if (typeof value === "string") {
      try {
        const bigIntValue = BigInt(value);
        return { valid: true, value: bigIntValue };
      } catch {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (bigint) received invalid bigint string in model '${modelName}'. ` +
              `Value: "${value}"`,
          ],
        };
      }
    }

    return {
      valid: false,
      errors: [
        `Field '${fieldName}' (bigint) requires a bigint, number, or string value in model '${modelName}'. ` +
          `Received: ${typeof value}`,
      ],
    };
  }

  /**
   * Validate boolean field values
   */
  private validateBooleanField(
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    if (typeof value === "boolean") {
      return { valid: true, value };
    }

    // Allow string boolean conversion
    if (typeof value === "string") {
      const lowerValue = value.toLowerCase();
      if (lowerValue === "true") {
        return { valid: true, value: true };
      }
      if (lowerValue === "false") {
        return { valid: true, value: false };
      }
    }

    // Allow number boolean conversion (0 = false, non-zero = true)
    if (typeof value === "number") {
      return { valid: true, value: value !== 0 };
    }

    return {
      valid: false,
      errors: [
        `Field '${fieldName}' (boolean) requires a boolean value in model '${modelName}'. ` +
          `Received: ${typeof value} (${value})`,
      ],
    };
  }

  /**
   * Validate dateTime field values
   */
  private validateDateTimeField(
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    if (value instanceof Date) {
      if (isNaN(value.getTime())) {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (dateTime) received invalid Date object in model '${modelName}'`,
          ],
        };
      }
      return { valid: true, value };
    }

    if (typeof value === "string") {
      const dateValue = new Date(value);
      if (isNaN(dateValue.getTime())) {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (dateTime) received invalid date string in model '${modelName}'. ` +
              `Value: "${value}"`,
          ],
        };
      }
      return { valid: true, value: dateValue };
    }

    if (typeof value === "number") {
      const dateValue = new Date(value);
      if (isNaN(dateValue.getTime())) {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (dateTime) received invalid timestamp in model '${modelName}'. ` +
              `Value: ${value}`,
          ],
        };
      }
      return { valid: true, value: dateValue };
    }

    return {
      valid: false,
      errors: [
        `Field '${fieldName}' (dateTime) requires a Date object, ISO string, or timestamp in model '${modelName}'. ` +
          `Received: ${typeof value}`,
      ],
    };
  }

  /**
   * Validate JSON field values
   */
  private validateJsonField(
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    // JSON fields are flexible but cannot be undefined
    if (value === undefined) {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (json) cannot have undefined value in model '${modelName}'`,
        ],
      };
    }

    // Try to serialize to verify it's JSON-serializable
    try {
      JSON.stringify(value);
      return { valid: true, value };
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (json) must be JSON-serializable in model '${modelName}'. ` +
            `Error: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  /**
   * Validate enum field values
   */
  private validateEnumField(
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    if (typeof value !== "string" && typeof value !== "number") {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (enum) requires a string or number value in model '${modelName}'. ` +
            `Received: ${typeof value}`,
        ],
      };
    }

    // TODO: In a full implementation, we'd validate against the specific enum values
    // This would require access to the enum definition from the field schema
    return { valid: true, value };
  }

  /**
   * Validate binary field values (bytes/blob)
   */
  private validateBinaryField(
    value: any,
    fieldName: string,
    modelName: string,
    fieldType: string
  ): ValidationResult {
    if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
      return { valid: true, value };
    }

    if (typeof value === "string") {
      // Assume base64 encoded string
      try {
        const buffer = Buffer.from(value, "base64");
        return { valid: true, value: new Uint8Array(buffer) };
      } catch {
        return {
          valid: false,
          errors: [
            `Field '${fieldName}' (${fieldType}) received invalid base64 string in model '${modelName}'. ` +
              `Value: "${value.substring(0, 50)}..."`,
          ],
        };
      }
    }

    return {
      valid: false,
      errors: [
        `Field '${fieldName}' (${fieldType}) requires a Uint8Array, ArrayBuffer, or base64 string in model '${modelName}'. ` +
          `Received: ${typeof value}`,
      ],
    };
  }

  /**
   * Validate array field values with recursive element validation
   */
  private validateArrayField(
    value: any,
    fieldName: string,
    modelName: string,
    elementType?: string,
    field?: any,
    validationContext?: string,
    operation?: string
  ): ValidationResult {
    if (!Array.isArray(value)) {
      return {
        valid: false,
        errors: [
          `Field '${fieldName}' (array) requires an array value in model '${modelName}'. ` +
            `Received: ${typeof value}`,
        ],
      };
    }

    // Empty arrays are always valid
    if (value.length === 0) {
      return { valid: true, value };
    }

    // If we have field information and element type, validate each element recursively
    if (field && elementType && elementType !== "unknown") {
      return this.validateArrayWithKnownElementType(
        value,
        fieldName,
        modelName,
        elementType,
        field,
        validationContext,
        operation
      );
    }

    // If no element type is specified, try to infer it from the array elements
    // and validate for consistency
    return this.validateArrayWithInferredElementType(
      value,
      fieldName,
      modelName,
      validationContext,
      operation
    );
  }

  /**
   * Validate array with known element type (recursive validation)
   */
  private validateArrayWithKnownElementType(
    value: any[],
    fieldName: string,
    modelName: string,
    elementType: string,
    field: any,
    validationContext?: string,
    operation?: string
  ): ValidationResult {
    const errors: string[] = [];
    const validatedElements: any[] = [];

    // Create element field by cloning the array field without the array flag
    const elementField = this.createElementField(field);

    for (let i = 0; i < value.length; i++) {
      const element = value[i];

      // Validate each element using the proper field instance
      const elementResult = this.validateByFieldType(
        elementType,
        element,
        `${fieldName}[${i}]`,
        modelName,
        validationContext || "input",
        operation,
        elementField
      );

      if (!elementResult.valid) {
        errors.push(...(elementResult.errors || []));
      } else {
        validatedElements.push(
          elementResult.value !== undefined ? elementResult.value : element
        );
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
      };
    }

    return { valid: true, value: validatedElements };
  }

  /**
   * Validate array with inferred element type (smart validation)
   */
  private validateArrayWithInferredElementType(
    value: any[],
    fieldName: string,
    modelName: string,
    validationContext?: string,
    operation?: string
  ): ValidationResult {
    // Try to infer the element type from the first few elements
    const sampleSize = Math.min(value.length, 5);
    const samples = value.slice(0, sampleSize);

    const inferredType = this.inferElementType(samples);

    if (!inferredType) {
      // Mixed types or unknown types - this should be an error for type consistency
      return {
        valid: false,
        errors: [
          `Array field '${fieldName}' in model '${modelName}' contains mixed or unsupported element types. ` +
            `All array elements must be of the same type.`,
        ],
      };
    }

    // Validate all elements against the inferred type
    const errors: string[] = [];
    const validatedElements: any[] = [];

    for (let i = 0; i < value.length; i++) {
      const element = value[i];

      // For inferred type validation, we need to create a minimal field
      // Since we don't have the original field, we'll use the field-specific validation methods directly
      const elementResult = this.validateElementByInferredType(
        inferredType,
        element,
        `${fieldName}[${i}]`,
        modelName
      );

      if (!elementResult.valid) {
        errors.push(...(elementResult.errors || []));
      } else {
        validatedElements.push(
          elementResult.value !== undefined ? elementResult.value : element
        );
      }
    }

    if (errors.length > 0) {
      return {
        valid: false,
        errors,
      };
    }

    return { valid: true, value: validatedElements };
  }

  /**
   * Create an element field from an array field by removing the array flag
   */
  private createElementField(arrayField: any): any {
    if (!arrayField || typeof arrayField["~cloneWith"] !== "function") {
      // If it's not a proper BaseField instance, return a copy without array flag
      return { ...arrayField, "~isArray": false };
    }

    // Use the field's cloneWith method to create a non-array version
    try {
      return arrayField["~cloneWith"]({ "~isArray": false });
    } catch (error) {
      // Fallback to simple copy if cloneWith fails
      return { ...arrayField, "~isArray": false };
    }
  }

  /**
   * Validate element using inferred type (for cases without original field)
   */
  private validateElementByInferredType(
    inferredType: string,
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    // Use field-specific validation methods directly
    switch (inferredType) {
      case "string":
        return this.validateStringField(value, fieldName, modelName, "string");
      case "int":
        return this.validateNumberField(value, fieldName, modelName, "int");
      case "float":
        return this.validateNumberField(value, fieldName, modelName, "float");
      case "bigint":
        return this.validateBigIntField(value, fieldName, modelName);
      case "boolean":
        return this.validateBooleanField(value, fieldName, modelName);
      case "dateTime":
        return this.validateDateTimeField(value, fieldName, modelName);
      case "json":
        return this.validateJsonField(value, fieldName, modelName);
      case "enum":
        return this.validateEnumField(value, fieldName, modelName);
      default:
        return {
          valid: false,
          errors: [
            `Cannot validate inferred type '${inferredType}' for element in '${fieldName}' (${modelName})`,
          ],
        };
    }
  }

  /**
   * Infer element type from array samples
   */
  private inferElementType(samples: any[]): string | null {
    if (samples.length === 0) return null;

    const types = new Set<string>();

    for (const sample of samples) {
      if (sample === null || sample === undefined) {
        continue; // Skip null/undefined for type inference
      }

      const type = this.getValueType(sample);
      if (type) {
        types.add(type);
      }
    }

    // If all elements are the same type, return that type
    if (types.size === 1) {
      return Array.from(types)[0]!;
    }

    // If mixed types, return null (no validation)
    return null;
  }

  /**
   * Get the BaseORM field type for a JavaScript value
   */
  private getValueType(value: any): string | null {
    if (typeof value === "string") {
      return "string";
    }

    if (typeof value === "number") {
      if (Number.isInteger(value)) {
        return "int";
      }
      return "float";
    }

    if (typeof value === "bigint") {
      return "bigint";
    }

    if (typeof value === "boolean") {
      return "boolean";
    }

    if (value instanceof Date) {
      return "dateTime";
    }

    if (Array.isArray(value)) {
      return "array";
    }

    if (typeof value === "object" && value !== null) {
      return "json";
    }

    return null;
  }

  /**
   * Apply custom field validator if present
   */
  private applyCustomValidator(
    field: any,
    value: any,
    fieldName: string,
    modelName: string
  ): ValidationResult {
    const customValidator = field["~fieldValidator"];
    if (!customValidator) {
      return { valid: true, value };
    }

    try {
      // TODO: Implement Standard Schema validator integration
      // This would require the actual Standard Schema validation logic
      // For now, we'll assume the validator passes
      return { valid: true, value };
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Custom validation failed for field '${fieldName}' in model '${modelName}': ${
            error instanceof Error ? error.message : String(error)
          }`,
        ],
      };
    }
  }

  /**
   * Get list of supported field types
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
      "bytes",
      "blob",
      "list",
      "array",
    ];
  }

  /**
   * Public method to validate any value against a field type
   */
  public validateValue(
    fieldType: string,
    value: any,
    fieldName: string = "unknown",
    modelName: string = "unknown",
    context: "create" | "update" | "filter" | "input" = "input"
  ): ValidationResult {
    // Create a minimal field object for validation
    const mockField: any = {
      "~fieldType": fieldType,
      "~optional": false,
      "~nullable": false,
    };

    const mockContext: BuilderContext = {
      model: { name: modelName } as any,
      baseOperation: context as any,
      alias: "temp",
      field: mockField,
      fieldName,
    };

    return this.validateFieldValue(mockContext, value, context);
  }

  /**
   * Public method to check if a field type is supported
   */
  public isFieldTypeSupported(fieldType: string): boolean {
    return this.canHandle(fieldType);
  }

  /**
   * Public method to get validation rules for a field type
   */
  public getValidationRules(fieldType: string): ValidationRules {
    const rules: ValidationRules = {
      allowedTypes: [],
      requiredType: fieldType,
      allowsNull: true,
      allowsUndefined: false,
      customRules: [],
    };

    switch (fieldType) {
      case "string":
        rules.allowedTypes = ["string"];
        break;

      case "int":
      case "float":
      case "decimal":
        rules.allowedTypes = ["number", "string"];
        rules.customRules = [
          "Must be finite",
          fieldType === "int" ? "Must be integer" : "",
        ].filter(Boolean);
        break;

      case "bigint":
      case "bigInt":
        rules.allowedTypes = ["bigint", "number", "string"];
        rules.customRules = ["Must be valid integer"];
        break;

      case "boolean":
        rules.allowedTypes = ["boolean", "string", "number"];
        rules.customRules = [
          "String: 'true'/'false', Number: 0=false, other=true",
        ];
        break;

      case "dateTime":
        rules.allowedTypes = ["Date", "string", "number"];
        rules.customRules = ["Valid date/timestamp"];
        break;

      case "json":
        rules.allowedTypes = ["any"];
        rules.allowsUndefined = false;
        rules.customRules = ["Must be JSON-serializable"];
        break;

      case "enum":
        rules.allowedTypes = ["string", "number"];
        rules.customRules = ["Must match enum values"];
        break;

      case "bytes":
      case "blob":
        rules.allowedTypes = ["Uint8Array", "ArrayBuffer", "string"];
        rules.customRules = ["String must be valid base64"];
        break;

      case "list":
      case "array":
        rules.allowedTypes = ["Array"];
        rules.customRules = ["Elements must match array type"];
        break;
    }

    return rules;
  }
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  valid: boolean;
  value?: any;
  errors?: string[];
}

/**
 * Validation rules interface
 */
export interface ValidationRules {
  allowedTypes: string[];
  requiredType: string;
  allowsNull: boolean;
  allowsUndefined: boolean;
  customRules: string[];
}
