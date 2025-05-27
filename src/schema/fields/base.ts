// Base Field Class
// Foundation for all field types with common functionality

import type {
  ScalarFieldType,
  FieldValidator,
  ValidationResult,
  AutoGenerateType,
} from "../../types/index.js";

import type {
  FieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
  InferInputType,
  InferStorageType,
  ValidateFieldState,
  BaseFieldType,
} from "../../types/field-states.js";

// Base Field class with simplified generic type system
export abstract class BaseField<
  T extends FieldState<any, any, any, any, any, any> = any
> implements BaseFieldType<T>
{
  // Hidden state property for type inference
  public readonly __fieldState!: T;

  // Runtime properties
  public fieldType?: ScalarFieldType | undefined;
  public isOptional: boolean = false;
  public isUnique: boolean = false;
  public isId: boolean = false;
  public isList: boolean = false;
  public defaultValue?: T["BaseType"] | (() => T["BaseType"]) | undefined;
  public autoGenerate?: AutoGenerateType | undefined;

  constructor() {}

  // Type-safe modifiers that return new field instances with updated types
  nullable(): BaseFieldType<MakeNullable<T>> {
    return this.cloneWith<MakeNullable<T>>({ isOptional: true });
  }

  default(value: InferType<T>): BaseFieldType<MakeDefault<T>> {
    return this.cloneWith<MakeDefault<T>>({ defaultValue: value });
  }

  unique(): BaseFieldType<MakeUnique<T>> {
    return this.cloneWith<MakeUnique<T>>({ isUnique: true });
  }

  id(): BaseFieldType<MakeId<T>> {
    return this.cloneWith<MakeId<T>>({ isId: true });
  }

  list(): BaseFieldType<MakeList<T>> {
    return this.cloneWith<MakeList<T>>({ isList: true });
  }

  // Auto-generation methods - to be implemented by specific field types
  // Each field type will implement only the relevant auto methods

  // Abstract method to create the correct instance type
  protected abstract createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U>;

  // Generic clone-and-modify helper for reducing duplication
  protected cloneWith<U extends FieldState<any, any, any, any, any, any>>(
    modifications: Partial<BaseField<any>> = {}
  ): BaseField<U> {
    const newField = this.createInstance<U>();
    this.copyPropertiesTo(newField);
    this.copyFieldSpecificProperties(newField);

    // Apply all modifications
    for (const [key, value] of Object.entries(modifications)) {
      (newField as any)[key] = value;
    }

    return newField;
  }

  // Hook for subclasses to copy their specific properties
  protected copyFieldSpecificProperties(target: BaseField<any>): void {
    // Base implementation does nothing - subclasses can override
  }

  // Validation method - accepts a single standard schema validator
  async validate(
    value: InferType<T>,
    validator?: FieldValidator<InferType<T>>
  ): Promise<ValidationResult<InferType<T>>> {
    const errors: string[] = [];
    let output: InferType<T> = value;
    try {
      // Type validation
      if (!this.validateType(value)) {
        errors.push(`Invalid type for field. Expected ${this.fieldType}`);
      }

      // Run standard schema validator if provided
      if (validator) {
        try {
          const result = await validator["~standard"].validate(value);

          if ("issues" in result && result.issues) {
            errors.push(...result.issues.map((issue: any) => issue.message));
          } else {
            output = result.value;
          }
        } catch (error) {
          errors.push(
            `Validator error: ${
              error instanceof Error ? error.message : "Unknown error"
            }`
          );
        }
      }
    } catch (error) {
      errors.push(
        `Validation error: ${
          error instanceof Error ? error.message : "Unknown error"
        }`
      );
    }

    const valid = errors.length === 0;
    return {
      output: valid ? output : undefined,
      valid,
      errors: valid ? undefined : errors,
    };
  }

  // Helper methods
  protected validateType(value: any): boolean {
    if (this.isOptional && (value === null || value === undefined)) {
      return true;
    }

    switch (this.fieldType) {
      case "string":
        return typeof value === "string";
      case "boolean":
        return typeof value === "boolean";
      case "int":
      case "float":
      case "decimal":
        return typeof value === "number";
      case "bigInt":
        return typeof value === "bigint";
      case "dateTime":
        return (
          value instanceof Date ||
          (typeof value === "string" && !isNaN(Date.parse(value)))
        );
      case "json":
        return true; // JSON can be any type
      case "blob":
        return value instanceof Uint8Array;
      default:
        return true;
    }
  }

  protected copyPropertiesTo(target: BaseField<any>): void {
    target.fieldType = this.fieldType;
    target.isOptional = this.isOptional;
    target.isUnique = this.isUnique;
    target.isId = this.isId;
    target.isList = this.isList;
    target.defaultValue = this.defaultValue;
    target.autoGenerate = this.autoGenerate;
  }

  // Type inference getters
  get infer(): InferType<T> {
    return {} as InferType<T>;
  }

  get inferInput(): InferInputType<T> {
    return {} as InferInputType<T>;
  }

  get inferStorage(): InferStorageType<T> {
    return {} as InferStorageType<T>;
  }

  get validateState(): ValidateFieldState<T> {
    return {} as ValidateFieldState<T>;
  }
}
