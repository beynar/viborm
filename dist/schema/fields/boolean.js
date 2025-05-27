// Boolean Field Class
// Simple boolean field with only common methods
import { BaseField } from "./base.js";
export class BooleanField extends BaseField {
    constructor() {
        super();
        this.fieldType = "boolean";
        this.validators = [];
    }
    createInstance() {
        const newField = new BooleanField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return BooleanField instances
    nullable() {
        const newField = new BooleanField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new BooleanField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new BooleanField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new BooleanField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new BooleanField();
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
// Factory function for creating boolean fields with proper typing
export function boolean() {
    return new BooleanField();
}
//# sourceMappingURL=boolean.js.map