// JSON Field Class
// Field for storing structured JSON data with optional schema validation
import { BaseField } from "./base.js";
export class JsonField extends BaseField {
    constructor(schema) {
        super();
        this.fieldType = "json";
        this.schema = schema;
    }
    createInstance() {
        const newField = new JsonField(this.schema);
        return newField;
    }
    // Override chainable methods to return JsonField instances with schema preserved
    nullable() {
        const newField = new JsonField(this.schema);
        this.copyPropertiesTo(newField);
        newField.isOptional = true;
        return newField;
    }
    list() {
        const newField = new JsonField(this.schema);
        this.copyPropertiesTo(newField);
        newField.isList = true;
        return newField;
    }
    id() {
        const newField = new JsonField(this.schema);
        this.copyPropertiesTo(newField);
        newField.isId = true;
        return newField;
    }
    default(value) {
        const newField = new JsonField(this.schema);
        this.copyPropertiesTo(newField);
        newField.defaultValue = value;
        return newField;
    }
    // Override validate to use schema validation if provided
    async validate(value) {
        const errors = [];
        try {
            // Basic type validation
            if (!this.validateType(value)) {
                errors.push(`Invalid type for field. Expected ${this.fieldType}`);
            }
            // Schema validation if provided
            if (this.schema) {
                try {
                    const result = await this.schema["~standard"].validate(value);
                    if ("issues" in result && result.issues) {
                        errors.push(...result.issues.map((issue) => issue.message));
                    }
                }
                catch (error) {
                    errors.push(`Schema validation error: ${error instanceof Error ? error.message : "Unknown error"}`);
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
    // Get the schema for external use
    getSchema() {
        return this.schema;
    }
}
export function json(schema) {
    if (schema) {
        return new JsonField(schema);
    }
    return new JsonField();
}
//# sourceMappingURL=json.js.map