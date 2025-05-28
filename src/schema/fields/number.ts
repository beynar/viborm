// Number Field Class
// Number-specific field with validation methods for numeric data

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeArray,
  MakeId,
  MakeUnique,
  MakeDefault,
  InferType,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class NumberField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<number>
> extends BaseField<T> {
  public override fieldType: "int" | "float" | "decimal" = "int";
  private fieldValidator?: FieldValidator<InferType<T>>;

  constructor(fieldType: "int" | "float" | "decimal" = "int") {
    super();
    this.fieldType = fieldType;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new NumberField<U>(this.fieldType);
    return newField as any;
  }

  // Copy number-specific properties
  protected override copyFieldSpecificProperties(target: BaseField<any>): void {
    (target as any).fieldValidator = this.fieldValidator;
  }

  // Override chainable methods to return NumberField instances
  override nullable(): NumberField<MakeNullable<T>> {
    return this.cloneWith<MakeNullable<T>>({ isOptional: true }) as NumberField<
      MakeNullable<T>
    >;
  }

  array(): NumberField<MakeArray<T>> {
    return this.cloneWith<MakeArray<T>>({ isArray: true }) as NumberField<
      MakeArray<T>
    >;
  }

  id(): NumberField<MakeId<T>> {
    return this.cloneWith<MakeId<T>>({ isId: true }) as NumberField<MakeId<T>>;
  }

  unique(): NumberField<MakeUnique<T>> {
    return this.cloneWith<MakeUnique<T>>({ isUnique: true }) as NumberField<
      MakeUnique<T>
    >;
  }

  override default(value: InferType<T>): NumberField<MakeDefault<T>> {
    return this.cloneWith<MakeDefault<T>>({
      defaultValue: value,
    }) as NumberField<MakeDefault<T>>;
  }

  // Number-specific auto-generation method (only for int fields)
  autoIncrement(): NumberField<T> {
    if (this.fieldType !== "int") {
      throw new Error(
        "autoIncrement() can only be used with int fields, not " +
          this.fieldType
      );
    }
    return this.cloneWith<T>({ autoGenerate: "increment" }) as NumberField<T>;
  }

  validator(validator: FieldValidator<InferType<T>>): this {
    this.fieldValidator = validator;
    return this;
  }
  // Override validate to include custom validator
  override async validate(value: any): Promise<any> {
    return super.validate(value, this.fieldValidator);
  }
}

// Factory functions
export function int(): NumberField<DefaultFieldState<number>> {
  return new NumberField("int");
}

export function float(): NumberField<DefaultFieldState<number>> {
  return new NumberField("float");
}

export function decimal(): NumberField<DefaultFieldState<number>> {
  return new NumberField("decimal");
}
