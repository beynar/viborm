// Schema Validation Utilities
// For validating models and their fields at the schema level

import type {
  ModelValidator,
  FieldValidator,
  ValidationResult,
} from "../types/index.js";

export interface SchemaValidationContext {
  modelName: string;
  fieldName?: string;
  path?: string[];
}

// Schema validator for complete models
export class SchemaValidator<T> {
  private validators: ModelValidator<T>[] = [];

  constructor(private modelName: string) {}

  addValidator(validator: ModelValidator<T>): void {
    this.validators.push(validator);
  }

  async validate(
    data: T,
    context?: SchemaValidationContext
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const validationContext = {
      modelName: this.modelName,
      ...context,
    };

    for (const validator of this.validators) {
      try {
        if (typeof validator === "function") {
          const result = await validator(data);
          if (result !== true) {
            errors.push(
              typeof result === "string" ? result : "Validation failed"
            );
          }
        } else if (
          validator &&
          typeof validator === "object" &&
          "~standard" in validator
        ) {
          const standardValidator = validator as any;
          const result = await standardValidator["~standard"].validate(data);

          if ("issues" in result) {
            errors.push(...result.issues.map((issue: any) => issue.message));
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(
          `Validation error in ${validationContext.modelName}: ${errorMessage}`
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// Field validator wrapper with context
export class FieldValidatorWrapper<T> {
  constructor(
    private validators: FieldValidator<T>[],
    private fieldName: string,
    private modelName: string
  ) {}

  async validate(value: T): Promise<ValidationResult> {
    const errors: string[] = [];
    const context: SchemaValidationContext = {
      modelName: this.modelName,
      fieldName: this.fieldName,
      path: [this.fieldName],
    };

    for (const validator of this.validators) {
      try {
        if (typeof validator === "function") {
          const result = await validator(value);
          if (result !== true) {
            const message =
              typeof result === "string" ? result : "Validation failed";
            errors.push(`${this.fieldName}: ${message}`);
          }
        } else if (
          validator &&
          typeof validator === "object" &&
          "~standard" in validator
        ) {
          const standardValidator = validator as any;
          const result = await standardValidator["~standard"].validate(value);

          if ("issues" in result) {
            errors.push(
              ...result.issues.map(
                (issue: any) => `${this.fieldName}: ${issue.message}`
              )
            );
          }
        }
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";
        errors.push(`${this.fieldName}: Validator error - ${errorMessage}`);
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }
}

// Utility to validate a complete record against schema
export async function validateRecord<T extends Record<string, any>>(
  data: T,
  fieldValidators: Record<string, FieldValidator<any>[]>,
  modelValidators: ModelValidator<T>[],
  modelName: string
): Promise<ValidationResult> {
  const allErrors: string[] = [];

  // Validate individual fields
  for (const [fieldName, value] of Object.entries(data)) {
    if (fieldValidators[fieldName]) {
      const fieldValidator = new FieldValidatorWrapper(
        fieldValidators[fieldName],
        fieldName,
        modelName
      );
      const result = await fieldValidator.validate(value);
      if (!result.valid && result.errors) {
        allErrors.push(...result.errors);
      }
    }
  }

  // Validate at model level
  const schemaValidator = new SchemaValidator<T>(modelName);
  modelValidators.forEach((validator) =>
    schemaValidator.addValidator(validator)
  );
  const modelResult = await schemaValidator.validate(data);
  if (!modelResult.valid && modelResult.errors) {
    allErrors.push(...modelResult.errors);
  }

  return {
    valid: allErrors.length === 0,
    errors: allErrors.length > 0 ? allErrors : undefined,
  };
}
