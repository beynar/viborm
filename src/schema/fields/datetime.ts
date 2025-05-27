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
  InferType,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class DateTimeField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<Date>
> extends BaseField<T> {
  public override fieldType = "dateTime" as const;
  private fieldValidator?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new DateTimeField<U>();
    (newField as any).fieldValidator = this.fieldValidator;
    return newField as any;
  }

  // Override chainable methods to return DateTimeField instances
  override nullable(): DateTimeField<MakeNullable<T>> {
    const newField = new DateTimeField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override list(): DateTimeField<MakeList<T>> {
    const newField = new DateTimeField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override id(): DateTimeField<MakeId<T>> {
    const newField = new DateTimeField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override unique(): DateTimeField<MakeUnique<T>> {
    const newField = new DateTimeField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override default(value: InferType<T>): DateTimeField<MakeDefault<T>> {
    const newField = new DateTimeField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  // DateTime-specific auto-generation methods (direct methods instead of nested auto object)
  now(): DateTimeField<T> {
    const newField = new DateTimeField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "now";
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  updatedAt(): DateTimeField<T> {
    const newField = new DateTimeField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "updatedAt";
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
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

// Factory function for creating datetime fields with proper typing
export function datetime(): DateTimeField<DefaultFieldState<Date>> {
  return new DateTimeField();
}
