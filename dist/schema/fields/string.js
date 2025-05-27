// String Field Class
// String-specific field with validation methods for text data
import { BaseField } from "./base.js";
export class StringField extends BaseField {
    constructor() {
        super();
        this.fieldType = "string";
    }
    createInstance() {
        return new StringField();
    }
    // String-specific validation methods
    regex(pattern) {
        this.regexPattern = pattern;
        return this;
    }
    min(length) {
        this.minLength = length;
        return this;
    }
    max(length) {
        this.maxLength = length;
        return this;
    }
    // Auto-generation for strings
    get auto() {
        return {
            uuid: () => {
                this.autoGenerate = "uuid";
                return this;
            },
            ulid: () => {
                this.autoGenerate = "ulid";
                return this;
            },
            nanoid: () => {
                this.autoGenerate = "nanoid";
                return this;
            },
            cuid: () => {
                this.autoGenerate = "cuid";
                return this;
            },
        };
    }
    // Override validation to include string-specific checks
    async validate(value, ...validators) {
        const baseResult = await super.validate(value, ...validators);
        const errors = [...(baseResult.errors || [])];
        if (this.fieldType === "string" && typeof value === "string") {
            if (this.regexPattern && !this.regexPattern.test(value)) {
                errors.push("Value does not match required pattern");
            }
            if (this.minLength !== undefined && value.length < this.minLength) {
                errors.push(`Value must be at least ${this.minLength} characters long`);
            }
            if (this.maxLength !== undefined && value.length > this.maxLength) {
                errors.push(`Value must be at most ${this.maxLength} characters long`);
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    copyPropertiesTo(target) {
        super.copyPropertiesTo(target);
        if (target instanceof StringField) {
            target.regexPattern = this.regexPattern;
            target.minLength = this.minLength;
            target.maxLength = this.maxLength;
        }
    }
    "~getRegexPattern"() {
        return this.regexPattern;
    }
    "~getMinLength"() {
        return this.minLength;
    }
    "~getMaxLength"() {
        return this.maxLength;
    }
}
//# sourceMappingURL=string.js.map