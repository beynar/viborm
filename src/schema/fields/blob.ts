// Blob Field Class
// Field for storing binary data

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

export class BlobField<
  T extends FieldState<
    any,
    any,
    any,
    any,
    any,
    any
  > = DefaultFieldState<Uint8Array>
> extends BaseField<T> {
  public override fieldType = "blob" as const;
  private validators: FieldValidator<Uint8Array>[] = [];

  constructor() {
    super();
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BlobField<U>();
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return BlobField instances
  override nullable(): BlobField<MakeNullable<T>> {
    const newField = new BlobField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): BlobField<MakeList<T>> {
    const newField = new BlobField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): BlobField<MakeId<T>> {
    const newField = new BlobField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): BlobField<MakeUnique<T>> {
    const newField = new BlobField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(
    value: T["BaseType"] | (() => T["BaseType"])
  ): BlobField<MakeDefault<T>> {
    const newField = new BlobField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<Uint8Array>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // Override validate to include custom validators
  override async validate(value: Uint8Array): Promise<any> {
    return super.validate(value, ...this.validators);
  }
}

// Factory function for creating blob fields with proper typing
export function blob(): BlobField<DefaultFieldState<Uint8Array>> {
  return new BlobField();
}
