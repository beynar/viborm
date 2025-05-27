// Boolean Field Class
// Simple boolean field with only common methods

import { BaseField } from "./base.js";

export class BooleanField extends BaseField<boolean> {
  constructor() {
    super();
    this.fieldType = "boolean";
  }

  protected createInstance<U>(): BaseField<U> {
    return new BooleanField() as any;
  }
}
