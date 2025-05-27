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
  StringAutoMethods,
  InferType,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class StringField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<string>
> extends BaseField<T> {
  public override fieldType = "string" as const;
  private validators: FieldValidator<string>[] = [];

  constructor() {
    super();
  }

  // Create new instance for method chaining
  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new StringField<U>();
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return StringField instances
  override nullable(): StringField<MakeNullable<T>> {
    const newField = new StringField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): StringField<MakeList<T>> {
    const newField = new StringField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): StringField<MakeId<T>> {
    const newField = new StringField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): StringField<MakeUnique<T>> {
    const newField = new StringField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(value: InferType<T>): StringField<MakeDefault<T>> {
    const newField = new StringField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<string>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // String-specific auto-generation methods
  get auto(): StringAutoMethods<StringField<T>> {
    return {
      uuid: (): StringField<T> => {
        const newField = new StringField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "uuid";
        (newField as any).validators = [...this.validators];
        return newField;
      },

      ulid: (): StringField<T> => {
        const newField = new StringField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "ulid";
        (newField as any).validators = [...this.validators];
        return newField;
      },

      nanoid: (): StringField<T> => {
        const newField = new StringField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "nanoid";
        (newField as any).validators = [...this.validators];
        return newField;
      },

      cuid: (): StringField<T> => {
        const newField = new StringField<T>();
        this.copyPropertiesTo(newField);
        (newField as any).autoGenerate = "cuid";
        (newField as any).validators = [...this.validators];
        return newField;
      },
    };
  }

  // Override validate to include custom validators
  override async validate(value: string): Promise<any> {
    return super.validate(value, ...this.validators);
  }
}

// Factory function for creating string fields with proper typing
export function string(): StringField<DefaultFieldState<string>> {
  return new StringField();
}
