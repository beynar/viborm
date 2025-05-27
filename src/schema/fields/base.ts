// Base Field Class
// Foundation for all field types with common functionality

import type {
  ScalarFieldType,
  FieldValidator,
  ValidationResult,
  StandardSchemaV1,
  AutoGenerateType,
} from "../../types/index.js";

import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
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
    const newField = this.createInstance<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    return newField;
  }

  default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): BaseFieldType<MakeDefault<T>> {
    const newField = this.createInstance<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    return newField;
  }

  unique(): BaseFieldType<MakeUnique<T>> {
    const newField = this.createInstance<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    return newField;
  }

  id(): BaseFieldType<MakeId<T>> {
    const newField = this.createInstance<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    return newField;
  }

  list(): BaseFieldType<MakeList<T>> {
    const newField = this.createInstance<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    return newField;
  }

  // Auto-generation methods
  get auto() {
    return {
      uuid: () => {
        if (this.fieldType !== "string") {
          throw new Error("uuid() can only be used with string fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "uuid";
        return newField;
      },

      ulid: () => {
        if (this.fieldType !== "string") {
          throw new Error("ulid() can only be used with string fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "ulid";
        return newField;
      },

      nanoid: () => {
        if (this.fieldType !== "string") {
          throw new Error("nanoid() can only be used with string fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "nanoid";
        return newField;
      },

      cuid: () => {
        if (this.fieldType !== "string") {
          throw new Error("cuid() can only be used with string fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "cuid";
        return newField;
      },

      increment: () => {
        if (this.fieldType !== "int") {
          throw new Error("increment() can only be used with int fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "increment";
        return newField;
      },

      now: () => {
        if (this.fieldType !== "dateTime") {
          throw new Error("now() can only be used with dateTime fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "now";
        return newField;
      },

      updatedAt: () => {
        if (this.fieldType !== "dateTime") {
          throw new Error("updatedAt() can only be used with dateTime fields");
        }
        const newField = this.createInstance<any>();
        this.copyPropertiesTo(newField);
        newField.autoGenerate = "updatedAt";
        return newField;
      },
    };
  }

  // Abstract method to create the correct instance type
  protected abstract createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U>;

  // Validation method - accepts any number of validators
  async validate(
    value: T["BaseType"],
    ...validators: FieldValidator<T["BaseType"]>[]
  ): Promise<ValidationResult> {
    const errors: string[] = [];

    try {
      // Type validation
      if (!this.validateType(value)) {
        errors.push(`Invalid type for field. Expected ${this.fieldType}`);
      }

      // Run all provided validators
      for (const validator of validators) {
        try {
          if (typeof validator === "function") {
            const result = await validator(value);
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
            const standardValidator = validator as StandardSchemaV1<
              T["BaseType"],
              T["BaseType"]
            >;
            const result = await standardValidator["~standard"].validate(value);

            if ("issues" in result) {
              errors.push(...result.issues.map((issue) => issue.message));
            }
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

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
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

  // Type inference getter
  get infer(): InferType<T> {
    return {} as InferType<T>;
  }
}
