// Number Field Implementation
// Type-safe number field with enhanced generics

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

export class NumberField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<number>
> extends BaseField<T> {
  public override "~fieldType": "int" | "float" | "decimal" = "int";
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new NumberField<U>();
    return newField as any;
  }

  // Copy number-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return NumberField instances
  override nullable(): NumberField<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as NumberField<MakeNullable<T>>;
  }

  array(): NumberField<MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({
      "~isArray": true,
    }) as NumberField<MakeArray<T>>;
  }

  id(): NumberField<MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as NumberField<
      MakeId<T>
    >;
  }

  unique(): NumberField<MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as NumberField<MakeUnique<T>>;
  }

  override default(value: InferType<T>): NumberField<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as NumberField<MakeDefault<T>>;
  }

  // Number type configuration methods
  int(): NumberField<T> {
    const newField = this["~cloneWith"]<T>({}) as NumberField<T>;
    newField["~fieldType"] = "int";
    return newField;
  }

  float(): NumberField<T> {
    const newField = this["~cloneWith"]<T>({}) as NumberField<T>;
    newField["~fieldType"] = "float";
    return newField;
  }

  decimal(): NumberField<T> {
    const newField = this["~cloneWith"]<T>({}) as NumberField<T>;
    newField["~fieldType"] = "decimal";
    return newField;
  }

  // Auto-generate methods for numbers
  autoIncrement(): NumberField<MakeAuto<T, "increment">> {
    return this["~cloneWith"]<MakeAuto<T, "increment">>({
      "~autoGenerate": "increment",
    }) as NumberField<MakeAuto<T, "increment">>;
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

// Factory function for creating number fields with proper typing
export function number(): NumberField<DefaultFieldState<number>> {
  return new NumberField();
}

// Factory functions for specific number types
export function int(): NumberField<DefaultFieldState<number>> {
  return new NumberField().int();
}

export function float(): NumberField<DefaultFieldState<number>> {
  return new NumberField().float();
}

export function decimal(): NumberField<DefaultFieldState<number>> {
  return new NumberField().decimal();
}
