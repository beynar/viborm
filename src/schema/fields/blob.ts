// Blob Field Class
// Field for storing binary data

import { BaseField } from "./base.js";

export class BlobField extends BaseField<Uint8Array> {
  constructor() {
    super();
    this.fieldType = "blob";
  }

  protected createInstance<U>(): BaseField<U> {
    return new BlobField() as any;
  }
}
