// Enum Field Class
// Field for storing enumerated values
import { BaseField } from "./base.js";
export class EnumField extends BaseField {
    constructor(values) {
        super();
        this.fieldType = "enum";
        this.enumValues = values;
    }
    createInstance() {
        return new EnumField(this.enumValues);
    }
}
