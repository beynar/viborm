// Blob Field Class
// Field for storing binary data
import { BaseField } from "./base.js";
export class BlobField extends BaseField {
    constructor() {
        super();
        this.fieldType = "blob";
    }
    createInstance() {
        return new BlobField();
    }
}
