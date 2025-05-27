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
  InferType,
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
  private fieldValidator?: FieldValidator<InferType<T>>;

  constructor(values: TEnum) {
    super();
    this.enumValues = values;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new EnumField<TEnum, U>(this.enumValues);
    return newField as any;
  }

  // Copy enum-specific properties
  protected override copyFieldSpecificProperties(target: BaseField<any>): void {
    (target as any).fieldValidator = this.fieldValidator;
  }

  // Override chainable methods to return EnumField instances
  override nullable(): EnumField<TEnum, MakeNullable<T>> {
    return this.cloneWith<MakeNullable<T>>({ isOptional: true }) as EnumField<
      TEnum,
      MakeNullable<T>
    >;
  }

  override list(): EnumField<TEnum, MakeList<T>> {
    return this.cloneWith<MakeList<T>>({ isList: true }) as EnumField<
      TEnum,
      MakeList<T>
    >;
  }

  override id(): EnumField<TEnum, MakeId<T>> {
    return this.cloneWith<MakeId<T>>({ isId: true }) as EnumField<
      TEnum,
      MakeId<T>
    >;
  }

  override unique(): EnumField<TEnum, MakeUnique<T>> {
    return this.cloneWith<MakeUnique<T>>({ isUnique: true }) as EnumField<
      TEnum,
      MakeUnique<T>
    >;
  }

  override default(value: InferType<T>): EnumField<TEnum, MakeDefault<T>> {
    return this.cloneWith<MakeDefault<T>>({ defaultValue: value }) as EnumField<
      TEnum,
      MakeDefault<T>
    >;
  }

  // Add validator method that accepts a single standard schema
  validator(validator: FieldValidator<InferType<T>>): this {
    this.fieldValidator = validator;
    return this;
  }

  // Override validate to include custom validator and enum validation
  override async validate(value: any): Promise<any> {
    // First check if value is in enum
    if (!this.enumValues.includes(value as any)) {
      return {
        valid: false,
        errors: [`Value must be one of: ${this.enumValues.join(", ")}`],
      };
    }

    return super.validate(value, this.fieldValidator);
  }
}

// Factory function for creating enum fields with proper typing
export function enumField<TEnum extends readonly (string | number)[]>(
  values: TEnum
): EnumField<TEnum, DefaultFieldState<TEnum[number]>> {
  return new EnumField(values);
}
