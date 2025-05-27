// JSON Field Class
// Field for storing structured JSON data

import { BaseField } from "./base.js";

export class JsonField<T = any> extends BaseField<T> {
  constructor() {
    super();
    this.fieldType = "json";
  }

  protected createInstance<U>(): BaseField<U> {
    return new JsonField() as any;
  }
}
