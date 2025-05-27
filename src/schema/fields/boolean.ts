// Boolean Field Class
// Simple boolean field with only common methods

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

export class BooleanField<
  T extends FieldState<
    any,
    any,
    any,
    any,
    any,
    any
  > = DefaultFieldState<boolean>
> extends BaseField<T> {
  public override fieldType = "boolean" as const;
  private fieldValidator?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BooleanField<U>();
    (newField as any).fieldValidator = this.fieldValidator;
    return newField as any;
  }

  // Override chainable methods to return BooleanField instances
  override nullable(): BooleanField<MakeNullable<T>> {
    const newField = new BooleanField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override list(): BooleanField<MakeList<T>> {
    const newField = new BooleanField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override id(): BooleanField<MakeId<T>> {
    const newField = new BooleanField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override unique(): BooleanField<MakeUnique<T>> {
    const newField = new BooleanField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override default(value: InferType<T>): BooleanField<MakeDefault<T>> {
    const newField = new BooleanField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  // Add validator method that accepts a single standard schema
  validator(validator: FieldValidator<InferType<T>>): this {
    this.fieldValidator = validator;
    return this;
  }

  // Override validate to include custom validator
  override async validate(value: any): Promise<any> {
    return super.validate(value, this.fieldValidator);
  }
}

// Factory function for creating boolean fields with proper typing
export function boolean(): BooleanField<DefaultFieldState<boolean>> {
  return new BooleanField();
}
