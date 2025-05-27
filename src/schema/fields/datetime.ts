// DateTime Field Class
// Date and time field with automatic timestamp generation

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
  MakeNullable,
  MakeList,
  MakeId,
  MakeUnique,
  MakeDefault,
  DateTimeAutoMethods,
  InferType,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class DateTimeField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<Date>
> extends BaseField<T> {
  public override fieldType = "dateTime" as const;
  private validators: FieldValidator<Date>[] = [];

  constructor() {
    super();
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new DateTimeField<U>();
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return DateTimeField instances
  override nullable(): DateTimeField<MakeNullable<T>> {
    const newField = new DateTimeField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): DateTimeField<MakeList<T>> {
    const newField = new DateTimeField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): DateTimeField<MakeId<T>> {
    const newField = new DateTimeField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): DateTimeField<MakeUnique<T>> {
    const newField = new DateTimeField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(value: InferType<T>): DateTimeField<MakeDefault<T>> {
    const newField = new DateTimeField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<Date>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // DateTime-specific auto-generation methods
  get auto(): DateTimeAutoMethods<DateTimeField<T>> {
    return {
      now: (): DateTimeField<T> => {
        const newField = new DateTimeField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "now";
        (newField as any).validators = [...this.validators];
        return newField;
      },
      updatedAt: (): DateTimeField<T> => {
        const newField = new DateTimeField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "updatedAt";
        (newField as any).validators = [...this.validators];
        return newField;
      },
    };
  }

  // Override validate to include custom validators
  override async validate(value: Date): Promise<any> {
    return super.validate(value, ...this.validators);
  }
}

// Factory function for creating datetime fields with proper typing
export function datetime(): DateTimeField<DefaultFieldState<Date>> {
  return new DateTimeField();
}
