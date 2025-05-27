// DateTime Field Class
// Date and time field with automatic timestamp generation
import { BaseField } from "./base.js";
export class DateTimeField extends BaseField {
    constructor() {
        super();
        this.fieldType = "dateTime";
    }
    createInstance() {
        return new DateTimeField();
    }
    // Auto-generation for dates
    get auto() {
        return {
            now: () => {
                this.autoGenerate = "now";
                return this;
            },
            updatedAt: () => {
                this.autoGenerate = "updatedAt";
                return this;
            },
        };
    }
}
