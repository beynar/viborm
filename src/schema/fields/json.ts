// JSON Field Class
// Field for storing structured JSON data with optional schema validation

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeArray,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
} from "../../types/field-states.js";
import type { StandardSchemaV1 } from "../../types/standardSchema.js";
import type { ValidationResult } from "../../types/validators.js";

export class JsonField<
  TData = any,
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<TData>
> extends BaseField<T> {
  public override "~fieldType" = "json" as const;
  private "~schema"?: any;

  constructor(schema?: any) {
    super();
    if (schema) {
      this["~schema"] = schema;
    }
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new JsonField<TData, U>(this["~schema"]);
    return newField as any;
  }

  // Copy json-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~schema"] = this["~schema"];
  }

  // Override chainable methods to return JsonField instances
  override nullable(): JsonField<TData, MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as JsonField<TData, MakeNullable<T>>;
  }

  array(): JsonField<TData, MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({ "~isArray": true }) as JsonField<
      TData,
      MakeArray<T>
    >;
  }

  id(): JsonField<TData, MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as JsonField<
      TData,
      MakeId<T>
    >;
  }

  unique(): JsonField<TData, MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as JsonField<TData, MakeUnique<T>>;
  }

  override default(value: InferType<T>): JsonField<TData, MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as JsonField<TData, MakeDefault<T>>;
  }
  // Override validate to use schema validation if provided
  override async "~validate"(
    value: any
  ): Promise<ValidationResult<InferType<T>>> {
    const errors: string[] = [];
    let output: InferType<T> = value;
    try {
      const isValidOptional =
        this["~isOptional"] && (value === null || value === undefined);
      // Basic type validation
      if (!this["~validateType"](value)) {
        errors.push(`Invalid type for field. Expected ${this["~fieldType"]}`);
      }

      // Schema validation if provided
      if (this["~schema"]) {
        if (isValidOptional) {
          return {
            output: null as any,
            valid: true,
            errors: undefined,
          };
        }
        try {
          const result = await this["~schema"]["~standard"].validate(value);

          if ("issues" in result && result.issues) {
            errors.push(...result.issues.map((issue: any) => issue.message));
          } else {
            output = result.value;
          }
        } catch (error) {
          errors.push(
            `Schema validation error: ${
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
}

export function json<T extends StandardSchemaV1 | undefined>(
  schema?: T
): JsonField<
  T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : any,
  DefaultFieldState<
    T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : any
  >
> {
  return new JsonField<
    T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : any,
    DefaultFieldState<
      T extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<T> : any
    >
  >(schema);
}
