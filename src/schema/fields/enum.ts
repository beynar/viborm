// Enum Field Class
// Field for storing enumerated values

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeUnique,
  MakeDefault,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class EnumField<
  TEnum extends readonly (string | number)[],
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<
    TEnum[number]
  >
> extends BaseField<T> {
  public override fieldType = "enum" as const;
  public readonly enumValues: TEnum;
  private validators: FieldValidator<TEnum[number]>[] = [];

  constructor(values: TEnum) {
    super();
    this.enumValues = values;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new EnumField<TEnum, U>(this.enumValues);
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return EnumField instances
  override nullable(): EnumField<TEnum, MakeNullable<T>> {
    const newField = new EnumField<TEnum, MakeNullable<T>>(this.enumValues);
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): EnumField<TEnum, MakeList<T>> {
    const newField = new EnumField<TEnum, MakeList<T>>(this.enumValues);
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): EnumField<TEnum, MakeId<T>> {
    const newField = new EnumField<TEnum, MakeId<T>>(this.enumValues);
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): EnumField<TEnum, MakeUnique<T>> {
    const newField = new EnumField<TEnum, MakeUnique<T>>(this.enumValues);
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): EnumField<TEnum, MakeDefault<T>> {
    const newField = new EnumField<TEnum, MakeDefault<T>>(this.enumValues);
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<TEnum[number]>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // Override validate to include custom validators and enum validation
  override async validate(value: TEnum[number]): Promise<any> {
    // First check if value is in enum
    if (!this.enumValues.includes(value as any)) {
      return {
        valid: false,
        errors: [`Value must be one of: ${this.enumValues.join(", ")}`],
      };
    }

    return super.validate(value, ...this.validators);
  }
}

// Factory function for creating enum fields with proper typing
export function enumField<TEnum extends readonly (string | number)[]>(
  values: TEnum
): EnumField<TEnum, DefaultFieldState<TEnum[number]>> {
  return new EnumField(values);
}
