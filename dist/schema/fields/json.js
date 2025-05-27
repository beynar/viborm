// JSON Field Class
// Field for storing structured JSON data
import { BaseField } from "./base.js";
export class JsonField extends BaseField {
    constructor() {
        super();
        this.fieldType = "json";
        this.validators = [];
    }
    createInstance() {
        const newField = new JsonField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return JsonField instances
    nullable() {
        const newField = new JsonField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new JsonField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new JsonField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new JsonField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new JsonField();
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
// Factory function for creating json fields with proper typing
export function json() {
    return new JsonField();
}
//# sourceMappingURL=json.js.map