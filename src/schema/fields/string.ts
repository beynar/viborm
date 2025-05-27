// String Field Implementation
// Type-safe string field with advanced generics

import { BaseField } from "./base.js";
import type {
  FieldState,
  DefaultFieldState,
} from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";

export class StringField<
  T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<string>
> extends BaseField<T> {
  public fieldType = "string" as const;
  private validators: FieldValidator<string>[] = [];

  constructor() {
    super();
  }

  // Create new instance for method chaining
  protected createInstance<
    U extends FieldState<any, any, any, any, any, any>
  >(): BaseField<U> {
    const newField = new StringField<U>();
    newField.validators = [...this.validators];
    return newField as any;
  }
}

// Factory function for creating string fields with proper typing
export function string(): StringField<DefaultFieldState<string>> {
  return new StringField();
}
