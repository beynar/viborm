// BigInt Field Class
// BigInt field for large integer values
import { BaseField } from "./base.js";
export class BigIntField extends BaseField {
    constructor() {
        super();
        this.fieldType = "bigInt";
        this.validators = [];
    }
    createInstance() {
        const newField = new BigIntField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return BigIntField instances
    nullable() {
        const newField = new BigIntField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new BigIntField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new BigIntField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new BigIntField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new BigIntField();
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
// Factory function for creating bigint fields with proper typing
export function bigint() {
    return new BigIntField();
}
//# sourceMappingURL=bigint.js.map