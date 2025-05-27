// Enum Field Class
// Field for storing enumerated values
import { BaseField } from "./base.js";
export class EnumField extends BaseField {
    constructor(values) {
        super();
        this.fieldType = "enum";
        this.validators = [];
        this.enumValues = values;
    }
    createInstance() {
        const newField = new EnumField(this.enumValues);
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return EnumField instances
    nullable() {
        const newField = new EnumField(this.enumValues);
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new EnumField(this.enumValues);
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new EnumField(this.enumValues);
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new EnumField(this.enumValues);
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new EnumField(this.enumValues);
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
    // Override validate to include custom validators and enum validation
    async validate(value) {
        // First check if value is in enum
        if (!this.enumValues.includes(value)) {
            return {
                valid: false,
                errors: [`Value must be one of: ${this.enumValues.join(", ")}`],
            };
        }
        return super.validate(value, ...this.validators);
    }
}
// Factory function for creating enum fields with proper typing
export function enumField(values) {
    return new EnumField(values);
}
//# sourceMappingURL=enum.js.map