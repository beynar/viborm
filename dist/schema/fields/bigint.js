// BigInt Field Class
// BigInt field for large integer values
import { BaseField } from "./base.js";
export class BigIntField extends BaseField {
    constructor() {
        super();
        this.fieldType = "bigInt";
    }
    createInstance() {
        return new BigIntField();
    }
}
//# sourceMappingURL=bigint.js.map