// BigInt Field Class
// BigInt field for large integer values

import { BaseField } from "./base.js";

export class BigIntField extends BaseField<bigint> {
  constructor() {
    super();
    this.fieldType = "bigInt";
  }

  protected createInstance<U>(): BaseField<U> {
    return new BigIntField() as any;
  }
}
