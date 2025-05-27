// Blob Field Class
// Field for storing binary data
import { BaseField } from "./base.js";
export class BlobField extends BaseField {
    constructor() {
        super();
        this.fieldType = "blob";
        this.validators = [];
    }
    createInstance() {
        const newField = new BlobField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return BlobField instances
    nullable() {
        const newField = new BlobField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new BlobField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new BlobField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new BlobField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new BlobField();
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
// Factory function for creating blob fields with proper typing
export function blob() {
    return new BlobField();
}
//# sourceMappingURL=blob.js.map