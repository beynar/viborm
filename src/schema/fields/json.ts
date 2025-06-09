// JSON Field Class
// Field for storing structured JSON data with optional schema validation

import { StandardSchemaV1 } from "../../standardSchema.js";
import { BaseField } from "./base.js";

import type {
  ValidationResult,
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeArray,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
} from "./types.js";
import {
  getBaseValidator,
  getCreateValidator,
  getFilterValidator,
  getUpdateValidator,
} from "./validators";

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

  override default(value: InferType<T>): JsonField<TData, MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as JsonField<TData, MakeDefault<T>>;
  }

  ["~baseValidator"] = getBaseValidator(this);
  ["~filterValidator"] = getFilterValidator(this);
  ["~createValidator"] = getCreateValidator(this);
  ["~updateValidator"] = getUpdateValidator(this);
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
