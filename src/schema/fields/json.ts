// JSON Field Class
// Field for storing structured JSON data with optional schema validation

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeDefault,
} from "../../types/field-states.js";
import type { StandardSchemaV1 } from "../../types/standardSchema.js";
import type { ValidationResult } from "../../types/validators.js";

export class JsonField<
  TData = any,
  T extends FieldState<
    TData,
    any,
    any,
    any,
    any,
    any
  > = DefaultFieldState<TData>
> extends BaseField<T> {
  public override fieldType = "json" as const;
  private schema: StandardSchemaV1<any, TData> | undefined;

  constructor(schema?: StandardSchemaV1<any, TData>) {
    super();
    this.schema = schema;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new JsonField<TData, U>(this.schema);
    return newField as any;
  }

  // Override chainable methods to return JsonField instances with schema preserved
  override nullable(): JsonField<TData, MakeNullable<T>> {
    const newField = new JsonField<TData, MakeNullable<T>>(this.schema);
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    return newField;
  }

  override list(): JsonField<TData, MakeList<T>> {
    const newField = new JsonField<TData, MakeList<T>>(this.schema);
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    return newField;
  }

  override id(): JsonField<TData, MakeId<T>> {
    const newField = new JsonField<TData, MakeId<T>>(this.schema);
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    return newField;
  }

  override default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): JsonField<TData, MakeDefault<T>> {
    const newField = new JsonField<TData, MakeDefault<T>>(this.schema);
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    return newField;
  }

  // Override validate to use schema validation if provided
  override async validate(value: TData): Promise<ValidationResult> {
    const errors: string[] = [];

    try {
      // Basic type validation
      if (!this.validateType(value)) {
        errors.push(`Invalid type for field. Expected ${this.fieldType}`);
      }

      // Schema validation if provided
      if (this.schema) {
        try {
          const result = await this.schema["~standard"].validate(value);

          if ("issues" in result && result.issues) {
            errors.push(...result.issues.map((issue: any) => issue.message));
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

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined,
    };
  }

  // Get the schema for external use
  getSchema(): StandardSchemaV1<any, TData> | undefined {
    return this.schema;
  }
}

// Factory function overloads for creating json fields with proper typing
export function json(): JsonField<any, DefaultFieldState<any>>;
export function json<TSchema extends StandardSchemaV1<any, any>>(
  schema: TSchema
): JsonField<
  StandardSchemaV1.InferOutput<TSchema>,
  DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>
>;
export function json<TSchema extends StandardSchemaV1<any, any>>(
  schema?: TSchema
):
  | JsonField<any, DefaultFieldState<any>>
  | JsonField<
      StandardSchemaV1.InferOutput<TSchema>,
      DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>
    > {
  if (schema) {
    return new JsonField<StandardSchemaV1.InferOutput<TSchema>>(schema);
  }
  return new JsonField<any>();
}
