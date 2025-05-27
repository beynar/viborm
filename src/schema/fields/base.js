// Base Field Class
// Foundation for all field types with common functionality
// Base Field class with simplified generic type system
export class BaseField {
    constructor() {
        this.isOptional = false;
        this.isUnique = false;
        this.isId = false;
        this.isList = false;
    }
    // Type-safe modifiers that return new field instances with updated types
    nullable() {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        return newField;
    }
    default(value) {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.defaultValue = value;
        return newField;
    }
    unique() {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.isUnique = true;
        return newField;
    }
    id() {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.isId = true;
        return newField;
    }
    list() {
        const newField = this.createInstance();
        this.copyPropertiesTo(newField);
        newField.isList = true;
        return newField;
    }
    // Auto-generation methods
    get auto() {
        return {
            uuid: () => {
                if (this.fieldType !== "string") {
                    throw new Error("uuid() can only be used with string fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "uuid";
                return newField;
            },
            ulid: () => {
                if (this.fieldType !== "string") {
                    throw new Error("ulid() can only be used with string fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "ulid";
                return newField;
            },
            nanoid: () => {
                if (this.fieldType !== "string") {
                    throw new Error("nanoid() can only be used with string fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "nanoid";
                return newField;
            },
            cuid: () => {
                if (this.fieldType !== "string") {
                    throw new Error("cuid() can only be used with string fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "cuid";
                return newField;
            },
            increment: () => {
                if (this.fieldType !== "int") {
                    throw new Error("increment() can only be used with int fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "increment";
                return newField;
            },
            now: () => {
                if (this.fieldType !== "dateTime") {
                    throw new Error("now() can only be used with dateTime fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "now";
                return newField;
            },
            updatedAt: () => {
                if (this.fieldType !== "dateTime") {
                    throw new Error("updatedAt() can only be used with dateTime fields");
                }
                const newField = this.createInstance();
                this.copyPropertiesTo(newField);
                newField.autoGenerate = "updatedAt";
                return newField;
            },
        };
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
                return (value instanceof Date ||
                    (typeof value === "string" && !isNaN(Date.parse(value))));
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
    // Type inference getter
    get infer() {
        return {};
    }
}
