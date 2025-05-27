// Number Field Class
// Number-specific field with validation methods for numeric data

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeUnique,
  MakeDefault,
  NumberAutoMethods,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class NumberField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<number>
> extends BaseField<T> {
  public override fieldType: "int" | "float" | "decimal" = "int";
  private validators: FieldValidator<number>[] = [];

  constructor(fieldType: "int" | "float" | "decimal" = "int") {
    super();
    this.fieldType = fieldType;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new NumberField<U>(this.fieldType);
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return NumberField instances
  override nullable(): NumberField<MakeNullable<T>> {
    const newField = new NumberField<MakeNullable<T>>(this.fieldType);
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): NumberField<MakeList<T>> {
    const newField = new NumberField<MakeList<T>>(this.fieldType);
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): NumberField<MakeId<T>> {
    const newField = new NumberField<MakeId<T>>(this.fieldType);
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): NumberField<MakeUnique<T>> {
    const newField = new NumberField<MakeUnique<T>>(this.fieldType);
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): NumberField<MakeDefault<T>> {
    const newField = new NumberField<MakeDefault<T>>(this.fieldType);
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<number>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // Number-specific auto-generation methods (only for int fields)
  get auto(): NumberAutoMethods<NumberField<T>> {
    return {
      increment: (): NumberField<T> => {
        if (this.fieldType !== "int") {
          throw new Error(
            "increment() can only be used with int fields, not " +
              this.fieldType
          );
        }
        const newField = new NumberField<T>(this.fieldType);
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "increment";
        (newField as any).validators = [...this.validators];
        return newField;
      },
    };
  }

  // Override validate to include custom validators
  override async validate(value: number): Promise<any> {
    return super.validate(value, ...this.validators);
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
