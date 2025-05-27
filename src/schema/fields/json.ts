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
  InferType,
} from "../../types/field-states.js";
import type { StandardSchemaV1 } from "../../types/standardSchema.js";
import type { ValidationResult } from "../../types/validators.js";

export class JsonField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<any>
> extends BaseField<T> {
  public override fieldType = "json" as const;
  private schema: StandardSchemaV1<any, any> | undefined;

  constructor(schema?: StandardSchemaV1<any, any>) {
    super();
    this.schema = schema;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new JsonField<U>(this.schema);
    return newField as any;
  }

  // Copy json-specific properties
  protected override copyFieldSpecificProperties(target: BaseField<any>): void {
    (target as any).schema = this.schema;
  }

  // Override chainable methods to return JsonField instances with schema preserved
  override nullable(): JsonField<MakeNullable<T>> {
    return this.cloneWith<MakeNullable<T>>({ isOptional: true }) as JsonField<
      MakeNullable<T>
    >;
  }

  override list(): JsonField<MakeList<T>> {
    return this.cloneWith<MakeList<T>>({ isList: true }) as JsonField<
      MakeList<T>
    >;
  }

  override id(): JsonField<MakeId<T>> {
    return this.cloneWith<MakeId<T>>({ isId: true }) as JsonField<MakeId<T>>;
  }

  override default(value: InferType<T>): JsonField<MakeDefault<T>> {
    return this.cloneWith<MakeDefault<T>>({ defaultValue: value }) as JsonField<
      MakeDefault<T>
    >;
  }

  // Override validate to use schema validation if provided
  override async validate(value: any): Promise<ValidationResult<InferType<T>>> {
    const errors: string[] = [];
    let output: InferType<T> = value;
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

  // Get the schema for external use
  getSchema(): StandardSchemaV1<any, any> | undefined {
    return this.schema;
  }
}

// Factory function overloads for creating json fields with proper typing
export function json(): JsonField<DefaultFieldState<any>>;
export function json<TSchema extends StandardSchemaV1<any, any>>(
  schema: TSchema
): JsonField<DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>>;
export function json<TSchema extends StandardSchemaV1<any, any>>(
  schema?: TSchema
):
  | JsonField<DefaultFieldState<any>>
  | JsonField<DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>> {
  if (schema) {
    return new JsonField<
      DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>
    >(schema);
  }
  return new JsonField<DefaultFieldState<any>>();
}
