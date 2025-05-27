// Validator Type Definitions
// Based on specifications: readme/6_validation.md and readme/1.2_field_class.md
// Built-in regex validators
export const BuiltInValidators = {
    email: /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/,
    url: /^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/,
    uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    ulid: /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/,
    ipv4: /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
    ipv6: /^(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/,
    phone: /^\+?[1-9]\d{1,14}$/,
    creditCard: /^[0-9]{13,19}$/,
    hexColor: /^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/,
    base64: /^[A-Za-z0-9+/]*={0,2}$/,
    jwt: /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/,
};
// Validation error types
export class ValidationError extends Error {
    constructor(message, field, errors) {
        super(message);
        this.field = field;
        this.errors = errors;
        this.name = "ValidationError";
    }
}
//# sourceMappingURL=validators.js.map