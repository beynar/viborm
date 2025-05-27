// DateTime Field Class
// Date and time field with automatic timestamp generation

import { BaseField } from "./base.js";

export class DateTimeField extends BaseField<Date> {
  constructor() {
    super();
    this.fieldType = "dateTime";
  }

  protected createInstance<U>(): BaseField<U> {
    return new DateTimeField() as any;
  }

  // Auto-generation for dates
  get auto() {
    return {
      now: (): this => {
        this.autoGenerate = "now";
        return this;
      },
      updatedAt: (): this => {
        this.autoGenerate = "updatedAt";
        return this;
      },
    };
  }
}
