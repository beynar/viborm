// DateTime Field Implementation
// Type-safe datetime field with enhanced generics

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
  MakeAuto,
  InferType,
} from "./types.js";
import {
  getBaseValidator,
  getCreateValidator,
  getFilterValidator,
  getUpdateValidator,
} from "./validators";

export class DateTimeField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<Date>
> extends BaseField<T> {
  public override "~fieldType" = "dateTime" as const;
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new DateTimeField<U>();
    return newField as any;
  }

  // Copy datetime-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return DateTimeField instances
  override nullable(): DateTimeField<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as DateTimeField<MakeNullable<T>>;
  }

  array(): DateTimeField<MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({
      "~isArray": true,
    }) as DateTimeField<MakeArray<T>>;
  }

  id(): DateTimeField<MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as DateTimeField<
      MakeId<T>
    >;
  }

  unique(): DateTimeField<MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as DateTimeField<MakeUnique<T>>;
  }

  override default(value: InferType<T>): DateTimeField<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as DateTimeField<MakeDefault<T>>;
  }

  // DateTime auto-generation methods
  now(): DateTimeField<MakeAuto<T, "now">> {
    return this["~cloneWith"]<MakeAuto<T, "now">>({
      "~autoGenerate": "now",
    }) as DateTimeField<MakeAuto<T, "now">>;
  }

  updatedAt(): DateTimeField<MakeAuto<T, "updatedAt">> {
    return this["~cloneWith"]<MakeAuto<T, "updatedAt">>({
      "~autoGenerate": "updatedAt",
    }) as DateTimeField<MakeAuto<T, "updatedAt">>;
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

// Factory function for creating datetime fields with proper typing
export function datetime(): DateTimeField<DefaultFieldState<Date>> {
  return new DateTimeField();
}
