// Number Field Class
// Number-specific field with validation methods for numeric data
import { BaseField } from "./base.js";
export class NumberField extends BaseField {
    constructor(fieldType = "int") {
        super();
        this.fieldType = "int";
        this.fieldType = fieldType;
    }
    createInstance() {
        return new NumberField(this.fieldType);
    }
}
// Factory functions
export function int() {
    return new NumberField("int");
}
export function float() {
    return new NumberField("float");
}
export function decimal() {
    return new NumberField("decimal");
}
