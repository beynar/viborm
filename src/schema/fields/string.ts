// String Field Implementation
// Type-safe string field with advanced generics

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
    return newField as any;
  }

  // Copy string-specific properties
  protected override copyFieldSpecificProperties(target: BaseField<any>): void {
    (target as any).fieldValidator = this.fieldValidator;
  }

  // Override chainable methods to return StringField instances
  override nullable(): StringField<MakeNullable<T>> {
    return this.cloneWith<MakeNullable<T>>({ isOptional: true }) as StringField<
      MakeNullable<T>
    >;
  }

  array(): StringField<MakeArray<T>> {
    return this.cloneWith<MakeArray<T>>({ isArray: true }) as StringField<
      MakeArray<T>
    >;
  }

  id(): StringField<MakeId<T>> {
    return this.cloneWith<MakeId<T>>({ isId: true }) as StringField<MakeId<T>>;
  }

  unique(): StringField<MakeUnique<T>> {
    return this.cloneWith<MakeUnique<T>>({ isUnique: true }) as StringField<
      MakeUnique<T>
    >;
  }

  override default(value: InferType<T>): StringField<MakeDefault<T>> {
    return this.cloneWith<MakeDefault<T>>({
      defaultValue: value,
    }) as StringField<MakeDefault<T>>;
  }

  // String-specific auto-generation methods (direct methods instead of nested auto object)
  uuid(): StringField<T> {
    return this.cloneWith<T>({ autoGenerate: "uuid" }) as StringField<T>;
  }

  ulid(): StringField<T> {
    return this.cloneWith<T>({ autoGenerate: "ulid" }) as StringField<T>;
  }

  nanoid(): StringField<T> {
    return this.cloneWith<T>({ autoGenerate: "nanoid" }) as StringField<T>;
  }

  cuid(): StringField<T> {
    return this.cloneWith<T>({ autoGenerate: "cuid" }) as StringField<T>;
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
