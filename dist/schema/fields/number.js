// Number Field Class
// Number-specific field with validation methods for numeric data
import { BaseField } from "./base.js";
export class NumberField extends BaseField {
    constructor(fieldType = "int") {
        super();
        this.fieldType = "int";
        this.validators = [];
        this.fieldType = fieldType;
    }
    createInstance() {
        const newField = new NumberField(this.fieldType);
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return NumberField instances
    nullable() {
        const newField = new NumberField(this.fieldType);
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new NumberField(this.fieldType);
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new NumberField(this.fieldType);
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new NumberField(this.fieldType);
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new NumberField(this.fieldType);
        this.copyPropertiesTo(newField);
        newField.defaultValue = value;
        newField.validators = [...this.validators];
        return newField;
    }
    // Add validator method that accepts standard schema or custom validation functions
    validator(...validators) {
        this.validators.push(...validators);
        return this;
    }
    // Override validate to include custom validators
    async validate(value) {
        return super.validate(value, ...this.validators);
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
//# sourceMappingURL=number.js.map