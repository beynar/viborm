// Runtime Validation Utilities
// For validating data during database operations
// Runtime validation error class
export class RuntimeValidationError extends Error {
    constructor(message, field, errors) {
        super(message);
        this.field = field;
        this.errors = errors;
        this.name = "RuntimeValidationError";
    }
}
// Validation result aggregator
export class ValidationAggregator {
    constructor(operation) {
        this.operation = operation;
        this.results = [];
        this.context = [];
    }
    addResult(result, context) {
        this.results.push(result);
        if (context) {
            this.context.push(context);
        }
    }
    getAggregatedResult() {
        const allErrors = [];
        let hasInvalid = false;
        this.results.forEach((result, index) => {
            if (!result.valid) {
                hasInvalid = true;
                if (result.errors) {
                    const contextPrefix = this.context[index]
                        ? `${this.context[index]}: `
                        : "";
                    allErrors.push(...result.errors.map((error) => `${contextPrefix}${error}`));
                }
            }
        });
        return {
            valid: !hasInvalid,
            errors: allErrors.length > 0 ? allErrors : undefined,
        };
    }
    throwIfInvalid() {
        const result = this.getAggregatedResult();
        if (!result.valid) {
            const message = this.operation
                ? `Validation failed for ${this.operation}`
                : "Validation failed";
            throw new RuntimeValidationError(message, undefined, result.errors);
        }
    }
}
// Type-safe value coercion
export function coerceValue(value, targetType) {
    switch (targetType) {
        case "string":
            return String(value);
        case "int":
            const intValue = parseInt(value, 10);
            if (isNaN(intValue)) {
                throw new RuntimeValidationError(`Cannot convert "${value}" to integer`);
            }
            return intValue;
        case "float":
            const floatValue = parseFloat(value);
            if (isNaN(floatValue)) {
                throw new RuntimeValidationError(`Cannot convert "${value}" to float`);
            }
            return floatValue;
        case "boolean":
            if (typeof value === "boolean")
                return value;
            if (typeof value === "string") {
                const lower = value.toLowerCase();
                if (lower === "true" || lower === "1")
                    return true;
                if (lower === "false" || lower === "0")
                    return false;
            }
            if (typeof value === "number") {
                return Boolean(value);
            }
            throw new RuntimeValidationError(`Cannot convert "${value}" to boolean`);
        case "dateTime":
            if (value instanceof Date)
                return value;
            if (typeof value === "string" || typeof value === "number") {
                const date = new Date(value);
                if (isNaN(date.getTime())) {
                    throw new RuntimeValidationError(`Cannot convert "${value}" to Date`);
                }
                return date;
            }
            throw new RuntimeValidationError(`Cannot convert "${value}" to Date`);
        case "json":
            if (typeof value === "string") {
                try {
                    return JSON.parse(value);
                }
                catch {
                    throw new RuntimeValidationError(`Invalid JSON: "${value}"`);
                }
            }
            return value;
        case "bigInt":
            try {
                return BigInt(value);
            }
            catch {
                throw new RuntimeValidationError(`Cannot convert "${value}" to BigInt`);
            }
        default:
            return value;
    }
}
// Safe value transformation
export function transformValue(value, transformer, fieldName) {
    try {
        return transformer(value);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : "Transformation failed";
        const context = fieldName ? ` for field "${fieldName}"` : "";
        throw new RuntimeValidationError(`Value transformation failed${context}: ${message}`);
    }
}
// Sanitize input data
export function sanitizeInput(data) {
    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
        if (value === undefined) {
            continue; // Skip undefined values
        }
        if (typeof value === "string") {
            // Basic string sanitization
            sanitized[key] = value.trim();
        }
        else if (value === null) {
            sanitized[key] = null;
        }
        else if (Array.isArray(value)) {
            sanitized[key] = value.map((item) => typeof item === "string" ? item.trim() : item);
        }
        else {
            sanitized[key] = value;
        }
    }
    return sanitized;
}
// Check if a value is empty/null/undefined
export function isEmpty(value) {
    if (value === null || value === undefined)
        return true;
    if (typeof value === "string")
        return value.trim() === "";
    if (Array.isArray(value))
        return value.length === 0;
    if (typeof value === "object")
        return Object.keys(value).length === 0;
    return false;
}
// Validate required fields
export function validateRequiredFields(data, requiredFields) {
    const errors = [];
    for (const field of requiredFields) {
        if (!(field in data) || isEmpty(data[field])) {
            errors.push(`Field "${field}" is required`);
        }
    }
    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
    };
}
//# sourceMappingURL=runtime.js.map