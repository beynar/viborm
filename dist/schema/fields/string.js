// String Field Implementation
// Type-safe string field with advanced generics
import { BaseField } from "./base.js";
export class StringField extends BaseField {
    constructor() {
        super();
        this.fieldType = "string";
        this.validators = [];
    }
    // Create new instance for method chaining
    createInstance() {
        const newField = new StringField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return StringField instances
    nullable() {
        const newField = new StringField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new StringField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new StringField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new StringField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new StringField();
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
// Factory function for creating string fields with proper typing
export function string() {
    return new StringField();
}
//# sourceMappingURL=string.js.map