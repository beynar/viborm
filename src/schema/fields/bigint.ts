// BigInt Field Implementation
// Type-safe bigint field with enhanced generics

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

export class BigIntField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<bigint>
> extends BaseField<T> {
  public override "~fieldType" = "bigInt" as const;
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BigIntField<U>();
    return newField as any;
  }

  // Copy bigint-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return BigIntField instances
  override nullable(): BigIntField<MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as BigIntField<MakeNullable<T>>;
  }

  array(): BigIntField<MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({
      "~isArray": true,
    }) as BigIntField<MakeArray<T>>;
  }

  id(): BigIntField<MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as BigIntField<
      MakeId<T>
    >;
  }

  unique(): BigIntField<MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as BigIntField<MakeUnique<T>>;
  }

  override default(value: InferType<T>): BigIntField<MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as BigIntField<MakeDefault<T>>;
  }

  // BigInt auto-generation method
  autoIncrement(): BigIntField<MakeAuto<T, "increment">> {
    return this["~cloneWith"]<MakeAuto<T, "increment">>({
      "~autoGenerate": "increment",
    }) as BigIntField<MakeAuto<T, "increment">>;
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

// Factory function for creating bigint fields with proper typing
export function bigint(): BigIntField<DefaultFieldState<bigint>> {
  return new BigIntField();
}
