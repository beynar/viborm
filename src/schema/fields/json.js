// JSON Field Class
// Field for storing structured JSON data
import { BaseField } from "./base.js";
export class JsonField extends BaseField {
    constructor() {
        super();
        this.fieldType = "json";
    }
    createInstance() {
        return new JsonField();
    }
}
