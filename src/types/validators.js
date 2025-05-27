// Validator Type Definitions
// Based on specifications: readme/6_validation.md and readme/1.2_field_class.md
// Validation error types
export class ValidationError extends Error {
    constructor(message, field, errors) {
        super(message);
        this.field = field;
        this.errors = errors;
        this.name = "ValidationError";
    }
}
