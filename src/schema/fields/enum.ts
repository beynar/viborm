// Enum Field Implementation
// Type-safe enum field with enhanced generics

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

export class EnumField<
  TEnum extends string[],
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<
    TEnum[number]
  >
> extends BaseField<T> {
  public override "~fieldType" = "enum" as const;
  private "~enumValues": TEnum;
  private "~fieldValidator"?: FieldValidator<InferType<T>>;

  constructor(enumValues: TEnum) {
    super();
    this["~enumValues"] = enumValues;
  }

  protected "~createInstance"<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new EnumField<TEnum, U>(this["~enumValues"]);
    return newField as any;
  }

  // Copy enum-specific properties
  protected override "~copyFieldSpecificProperties"(
    target: BaseField<any>
  ): void {
    (target as any)["~fieldValidator"] = this["~fieldValidator"];
  }

  // Override chainable methods to return EnumField instances
  override nullable(): EnumField<TEnum, MakeNullable<T>> {
    return this["~cloneWith"]<MakeNullable<T>>({
      "~isOptional": true,
    }) as EnumField<TEnum, MakeNullable<T>>;
  }

  array(): EnumField<TEnum, MakeArray<T>> {
    return this["~cloneWith"]<MakeArray<T>>({ "~isArray": true }) as EnumField<
      TEnum,
      MakeArray<T>
    >;
  }

  id(): EnumField<TEnum, MakeId<T>> {
    return this["~cloneWith"]<MakeId<T>>({ "~isId": true }) as EnumField<
      TEnum,
      MakeId<T>
    >;
  }

  unique(): EnumField<TEnum, MakeUnique<T>> {
    return this["~cloneWith"]<MakeUnique<T>>({
      "~isUnique": true,
    }) as EnumField<TEnum, MakeUnique<T>>;
  }

  override default(value: InferType<T>): EnumField<TEnum, MakeDefault<T>> {
    return this["~cloneWith"]<MakeDefault<T>>({
      "~defaultValue": value,
    }) as EnumField<TEnum, MakeDefault<T>>;
  }

  // Add validator method that accepts a single standard schema
  validator(validator: FieldValidator<InferType<T>>): this {
    this["~fieldValidator"] = validator;
    return this;
  }

  // Get enum values for external use
  "~getEnumValues"(): TEnum {
    return this["~enumValues"];
  }

  // Override validate to include enum validation
  override async "~validate"(value: any): Promise<any> {
    const isValidOptional =
      this["~isOptional"] && (value === null || value === undefined);
    // Check if value is one of the allowed enum values
    if (!this["~enumValues"].includes(value) && !isValidOptional) {
      return {
        output: undefined,
        valid: false,
        errors: [`Value must be one of: ${this["~enumValues"].join(", ")}`],
      };
    }

    return super["~validate"](value, this["~fieldValidator"]);
  }
}

// Factory function for creating enum fields with proper typing
export function enumField<T extends string[]>(
  enumValues: T
): EnumField<T, DefaultFieldState<T[number]>> {
  return new EnumField(enumValues);
}
