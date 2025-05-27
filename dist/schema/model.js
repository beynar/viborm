// Model Class Implementation
// Based on specification: readme/1.1_model_class.md
import { BaseField } from "./field.js";
import { Relation } from "./relation.js";
export class Model {
    constructor(name, fieldDefinitions) {
        this.name = name;
        this.fieldDefinitions = fieldDefinitions;
        this.fields = new Map();
        this.relations = new Map();
        this.indexes = [];
        this.uniqueConstraints = [];
        this.separateFieldsAndRelations(fieldDefinitions);
    }
    separateFieldsAndRelations(definitions) {
        for (const [key, definition] of Object.entries(definitions)) {
            if (definition instanceof BaseField) {
                this.fields.set(key, definition);
            }
            else if (definition instanceof Relation) {
                this.relations.set(key, definition);
            }
            else {
                throw new Error(`Invalid field definition for '${key}'. Must be a Field or Relation instance.`);
            }
        }
    }
    // Database table mapping
    map(tableName) {
        if (!tableName ||
            typeof tableName !== "string" ||
            tableName.trim() === "") {
            throw new Error("Table name must be a non-empty string");
        }
        this.tableName = tableName;
        return this;
    }
    // Index management
    index(fields, options = {}) {
        const fieldArray = Array.isArray(fields) ? fields : [fields];
        // Validate all fields exist
        for (const field of fieldArray) {
            if (!this.fields.has(field)) {
                const availableFields = Array.from(this.fields.keys());
                throw new Error(`Field '${field}' does not exist in model '${this.name}'. Available fields: ${availableFields.join(", ")}`);
            }
        }
        this.indexes.push({
            fields: fieldArray,
            options,
        });
        return this;
    }
    // Unique constraints
    unique(fields, options = {}) {
        const fieldArray = Array.isArray(fields) ? fields : [fields];
        // Validate all fields exist
        for (const field of fieldArray) {
            if (!this.fields.has(field)) {
                const availableFields = Array.from(this.fields.keys());
                throw new Error(`Field '${field}' does not exist in model '${this.name}'. Available fields: ${availableFields.join(", ")}`);
            }
        }
        this.uniqueConstraints.push({
            fields: fieldArray,
            options,
        });
        return this;
    }
    // Validation execution - accepts any number of validators
    async validate(data, ...validators) {
        const errors = [];
        for (const validator of validators) {
            try {
                if (typeof validator === "function") {
                    // Function validator
                    const result = await validator(data);
                    if (result !== true) {
                        errors.push(typeof result === "string" ? result : "Validation failed");
                    }
                }
                else if (validator &&
                    typeof validator === "object" &&
                    "~standard" in validator) {
                    // Standard Schema validator
                    const standardValidator = validator;
                    const result = await standardValidator["~standard"].validate(data);
                    if ("issues" in result) {
                        errors.push(...result.issues.map((issue) => issue.message));
                    }
                }
            }
            catch (error) {
                errors.push(`Validation error: ${error instanceof Error ? error.message : "Unknown error"}`);
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
    // Internal introspection methods (prefixed with ~ to keep them out of autocompletion)
    "~getFields"() {
        return Object.fromEntries(this.fields);
    }
    "~getRelations"() {
        return Object.fromEntries(this.relations);
    }
    "~getIndexes"() {
        return [...this.indexes];
    }
    "~getUniqueConstraints"() {
        return [...this.uniqueConstraints];
    }
    "~getTableName"() {
        if (!this.tableName) {
            throw new Error(`Table name not set for model '${this.name}'. Use .map() method to set the database table name.`);
        }
        return this.tableName;
    }
    "~getName"() {
        return this.name;
    }
    get infer() {
        return {};
    }
}
//# sourceMappingURL=model.js.map