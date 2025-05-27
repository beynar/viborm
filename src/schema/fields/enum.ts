// Enum Field Class
// Field for storing enumerated values

import { BaseField } from "./base.js";

export class EnumField<
  TEnum extends readonly (string | number)[]
> extends BaseField<TEnum[number]> {
  public readonly enumValues: TEnum;

  constructor(values: TEnum) {
    super();
    this.fieldType = "enum";
    this.enumValues = values;
  }

  protected createInstance<U>(): BaseField<U> {
    return new EnumField(this.enumValues) as any;
  }
}
