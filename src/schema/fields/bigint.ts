// BigInt Field Class
// BigInt field for large integer values

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

export class BigIntField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<bigint>
> extends BaseField<T> {
  public override fieldType = "bigInt" as const;
  private validators: FieldValidator<bigint>[] = [];

  constructor() {
    super();
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new BigIntField<U>();
    (newField as any).validators = [...this.validators];
    return newField as any;
  }

  // Override chainable methods to return BigIntField instances
  override nullable(): BigIntField<MakeNullable<T>> {
    const newField = new BigIntField<MakeNullable<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isOptional = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override list(): BigIntField<MakeList<T>> {
    const newField = new BigIntField<MakeList<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isList = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override id(): BigIntField<MakeId<T>> {
    const newField = new BigIntField<MakeId<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isId = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override unique(): BigIntField<MakeUnique<T>> {
    const newField = new BigIntField<MakeUnique<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).isUnique = true;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  override default(value: InferType<T>): BigIntField<MakeDefault<T>> {
    const newField = new BigIntField<MakeDefault<T>>();
    this.copyPropertiesTo(newField);
    (newField as any).defaultValue = value;
    (newField as any).validators = [...this.validators];
    return newField;
  }

  // Add validator method that accepts standard schema or custom validation functions
  validator(...validators: FieldValidator<bigint>[]): this {
    this.validators.push(...validators);
    return this;
  }

  // Override validate to include custom validators
  override async validate(value: bigint): Promise<any> {
    return super.validate(value, ...this.validators);
  }
}

// Factory function for creating bigint fields with proper typing
export function bigint(): BigIntField<DefaultFieldState<bigint>> {
  return new BigIntField();
}
