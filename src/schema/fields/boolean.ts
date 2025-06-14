// Boolean Field Implementation
// Type-safe boolean field with enhanced generics

import { BaseField } from "./base.js";

import type {
  FieldValidator,
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

export class BooleanField<
  T extends FieldState<
    any,
    any,
    any,
    any,
    any,
    any
  > = DefaultFieldState<boolean>
> extends BaseField<T> {
  public override "~fieldType" = "boolean" as const;
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BooleanField<U>();
    return newField as any;
  }

  // Copy boolean-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return BooleanField instances
  override nullable(): BooleanField<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as BooleanField<MakeNullable<T>>;
  }

  array(): BooleanField<MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({
      "~isArray": true,
    }) as BooleanField<MakeArray<T>>;
  }

  id(): BooleanField<MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as BooleanField<
      MakeId<T>
    >;
  }

  unique(): BooleanField<MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as BooleanField<MakeUnique<T>>;
  }

  override default(value: InferType<T>): BooleanField<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as BooleanField<MakeDefault<T>>;
  }

  // Add validator method that accepts a single standard schema
  validator(validator: FieldValidator<InferType<T>>): this {
    this["~fieldValidator"] = validator;
    return this;
  }

  ["~baseValidator"] = getBaseValidator(this);
  ["~filterValidator"] = getFilterValidator(this);
  ["~createValidator"] = getCreateValidator(this);
  ["~updateValidator"] = getUpdateValidator(this);
}

// Factory function for creating boolean fields with proper typing
export function boolean(): BooleanField<DefaultFieldState<boolean>> {
  return new BooleanField();
}
