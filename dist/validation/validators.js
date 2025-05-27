// Validation Utilities and Helper Functions
// Based on specification: readme/4_validation.md
// Validation executor for field validators
export async function validateField(value, validators) {
    const errors = [];
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
    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
    };
}
// Validation executor for model validators
export async function validateModel(data, validators) {
    const errors = [];
    for (const validator of validators) {
        try {
            if (typeof validator === "function") {
                const result = await validator(data);
                if (result !== true) {
                    errors.push(typeof result === "string" ? result : "Validation failed");
                }
            }
            else if (validator &&
                typeof validator === "object" &&
                "~standard" in validator) {
                const standardValidator = validator;
                const result = await standardValidator["~standard"].validate(data);
                if ("issues" in result) {
                    errors.push(...result.issues.map((issue) => issue.message));
                }
            }
        }
        catch (error) {
            errors.push(`Validator error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
    }
    return {
        valid: errors.length === 0,
        errors: errors.length > 0 ? errors : undefined,
    };
}
// Compose multiple validators
export function composeValidators(...validators) {
    return async (value) => {
        const result = await validateField(value, validators);
        if (!result.valid && result.errors) {
            return result.errors.join("; ");
        }
        return true;
    };
}
// Create a regex validator
export function regexValidator(pattern, message) {
    return (value) => {
        if (!pattern.test(value)) {
            return message || "Value does not match required pattern";
        }
        return true;
    };
}
// Create a length validator
export function lengthValidator(min, max, message) {
    return (value) => {
        if (min !== undefined && value.length < min) {
            return message || `Value must be at least ${min} characters long`;
        }
        if (max !== undefined && value.length > max) {
            return message || `Value must be at most ${max} characters long`;
        }
        return true;
    };
}
// Create a range validator for numbers
export function rangeValidator(min, max, message) {
    return (value) => {
        if (min !== undefined && value < min) {
            return message || `Value must be at least ${min}`;
        }
        if (max !== undefined && value > max) {
            return message || `Value must be at most ${max}`;
        }
        return true;
    };
}
// Create an enum validator
export function enumValidator(values, message) {
    return (value) => {
        if (!values.includes(value)) {
            return message || `Value must be one of: ${values.join(", ")}`;
        }
        return true;
    };
}
// Built-in email validator
export const emailValidator = regexValidator(/^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/, "Invalid email format");
// Built-in URL validator
export const urlValidator = regexValidator(/^https?:\/\/(www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_\+.~#?&//=]*)$/, "Invalid URL format");
// Built-in UUID validator
export const uuidValidator = regexValidator(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "Invalid UUID format");
// Built-in ULID validator
export const ulidValidator = regexValidator(/^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/, "Invalid ULID format");
//# sourceMappingURL=validators.js.map