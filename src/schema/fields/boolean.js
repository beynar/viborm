// Boolean Field Class
// Simple boolean field with only common methods
import { BaseField } from "./base.js";
export class BooleanField extends BaseField {
    constructor() {
        super();
        this.fieldType = "boolean";
    }
    createInstance() {
        return new BooleanField();
    }
}
