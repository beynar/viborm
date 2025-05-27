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
    // Add custom validators
    validator(...validators) {
        this.validators.push(...validators);
        return this;
    }
    // String-specific validations with proper chaining
    minLength(min) {
        this.validators.push((value) => {
            if (typeof value === "string" && value.length < min) {
                return `String must be at least ${min} characters long`;
            }
            return true;
        });
        return this;
    }
    maxLength(max) {
        this.validators.push((value) => {
            if (typeof value === "string" && value.length > max) {
                return `String must be at most ${max} characters long`;
            }
            return true;
        });
        return this;
    }
    regex(pattern, message) {
        this.validators.push((value) => {
            if (typeof value === "string" && !pattern.test(value)) {
                return message || `String must match pattern ${pattern}`;
            }
            return true;
        });
        return this;
    }
    email() {
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return this.regex(emailRegex, "Must be a valid email address");
    }
    url() {
        this.validators.push((value) => {
            try {
                new URL(value);
                return true;
            }
            catch {
                return "Must be a valid URL";
            }
        });
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
