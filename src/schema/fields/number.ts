// Number Field Class
// Number-specific field with validation methods for numeric data

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
} from "../../types/field-states.js";

export class NumberField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<number>
> extends BaseField<T> {
  public fieldType: "int" | "float" | "decimal" = "int";

  constructor(fieldType: "int" | "float" | "decimal" = "int") {
    super();
    this.fieldType = fieldType;
  }

  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    return new NumberField<U>(this.fieldType) as any;
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
