// DateTime Field Class
// Date and time field with automatic timestamp generation
import { BaseField } from "./base.js";
export class DateTimeField extends BaseField {
    constructor() {
        super();
        this.fieldType = "dateTime";
        this.validators = [];
    }
    createInstance() {
        const newField = new DateTimeField();
        newField.validators = [...this.validators];
        return newField;
    }
    // Override chainable methods to return DateTimeField instances
    nullable() {
        const newField = new DateTimeField();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        newField.validators = [...this.validators];
        return newField;
    }
    list() {
        const newField = new DateTimeField();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        newField.validators = [...this.validators];
        return newField;
    }
    id() {
        const newField = new DateTimeField();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        newField.validators = [...this.validators];
        return newField;
    }
    unique() {
        const newField = new DateTimeField();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        newField.validators = [...this.validators];
        return newField;
    }
    default(value) {
        const newField = new DateTimeField();
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
    // Auto-generation methods - implement base interface plus date-specific ones
    get auto() {
        return {
            uuid: () => {
                throw new Error("uuid() can only be used with string fields");
            },
            ulid: () => {
                throw new Error("ulid() can only be used with string fields");
            },
            nanoid: () => {
                throw new Error("nanoid() can only be used with string fields");
            },
            cuid: () => {
                throw new Error("cuid() can only be used with string fields");
            },
            increment: () => {
                throw new Error("increment() can only be used with int fields");
            },
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
    // Override validate to include custom validators
    async validate(value) {
        return super.validate(value, ...this.validators);
    }
}
// Factory function for creating datetime fields with proper typing
export function datetime() {
    return new DateTimeField();
}
//# sourceMappingURL=datetime.js.map