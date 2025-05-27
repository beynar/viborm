// String Field Implementation
// Type-safe string field with advanced generics

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

export class StringField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<string>
> extends BaseField<T> {
  public override fieldType = "string" as const;
  private fieldValidator?: FieldValidator<InferType<T>>;

  constructor() {
    super();
  }

  // Create new instance for method chaining
  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new StringField<U>();
    (newField as any).fieldValidator = this.fieldValidator;
    return newField as any;
  }

  // Override chainable methods to return StringField instances
  override nullable(): StringField<MakeNullable<T>> {
    const newField = new StringField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override list(): StringField<MakeList<T>> {
    const newField = new StringField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override id(): StringField<MakeId<T>> {
    const newField = new StringField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override unique(): StringField<MakeUnique<T>> {
    const newField = new StringField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  override default(value: InferType<T>): StringField<MakeDefault<T>> {
    const newField = new StringField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  // String-specific auto-generation methods (direct methods instead of nested auto object)
  uuid(): StringField<T> {
    const newField = new StringField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "uuid";
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  ulid(): StringField<T> {
    const newField = new StringField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "ulid";
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  nanoid(): StringField<T> {
    const newField = new StringField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "nanoid";
    (newField as any).fieldValidator = this.fieldValidator;
    return newField;
  }

  cuid(): StringField<T> {
    const newField = new StringField<T>();
    this.copyPropertiesTo(newField);
    (newField as any).autoGenerate = "cuid";
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

// Factory function for creating string fields with proper typing
export function string(): StringField<DefaultFieldState<string>> {
  return new StringField();
}
