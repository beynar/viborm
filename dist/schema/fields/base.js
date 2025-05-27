// Base Field Class
// Foundation for all field types with common functionality
// Base Field class with common functionality
export class BaseField {
    constructor() {
        this.isOptional = false;
        this.isUnique = false;
        this.isId = false;
        this.isList = false;
    }
    // Common modifiers available to all field types
    nullable() {
        this.isOptional = true;
        return this;
    }
    default(value) {
        this.defaultValue = value;
        return this;
    }
    unique() {
        this.isUnique = true;
        return this;
    }
    id() {
        this.isId = true;
        return this;
    }
    list() {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        return newField;
    }
    // Validation method - accepts any number of validators
    async validate(value, ...validators) {
        const errors = [];
        try {
            // Type validation
            if (!this.validateType(value)) {
                errors.push(`Invalid type for field. Expected ${this.fieldType}`);
            }
            // Run all provided validators
            for (const validator of validators) {
                try {
                    if (typeof validator === "function") {
                        const result = await validator(value);
                        if (result !== true) {
                            errors.push(typeof result === "string" ? result : "Validation failed");
                        }
                    }
                    else if (validator &&
                        typeof validator === "object" &&
                        "~standard" in validator) {
                        const standardValidator = validator;
                        const result = await standardValidator["~standard"].validate(value);
                        if ("issues" in result) {
                            errors.push(...result.issues.map((issue) => issue.message));
                        }
                    }
                }
                catch (error) {
                    errors.push(`Validator error: ${error instanceof Error ? error.message : "Unknown error"}`);
                }
            }
        }
        catch (error) {
            errors.push(`Validation error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    // Helper methods
    validateType(value) {
        if (this.isOptional && (value === null || value === undefined)) {
            return true;
        }
        switch (this.fieldType) {
            case "string":
                return typeof value === "string";
            case "boolean":
                return typeof value === "boolean";
            case "int":
            case "float":
            case "decimal":
                return typeof value === "number";
            case "bigInt":
                return typeof value === "bigint";
            case "dateTime":
                return value instanceof Date;
            case "json":
                return true; // JSON can be any type
            case "blob":
                return value instanceof Uint8Array;
            default:
                return true;
        }
    }
    copyPropertiesTo(target) {
        target.fieldType = this.fieldType;
        target.isOptional = this.isOptional;
        target.isUnique = this.isUnique;
        target.isId = this.isId;
        target.isList = this.isList;
        target.defaultValue = this.defaultValue;
        target.autoGenerate = this.autoGenerate;
    }
    // Internal getters for introspection (prefixed with ~ to keep them out of autocompletion)
    "~getType"() {
        return this.fieldType;
    }
    get infer() {
        return {};
    }
    "~getIsOptional"() {
        return this.isOptional;
    }
    "~getIsUnique"() {
        return this.isUnique;
    }
    "~getIsId"() {
        return this.isId;
    }
    "~getIsList"() {
        return this.isList;
    }
    "~getDefaultValue"() {
        return this.defaultValue;
    }
    "~getAutoGenerate"() {
        return this.autoGenerate;
    }
}
//# sourceMappingURL=base.js.map