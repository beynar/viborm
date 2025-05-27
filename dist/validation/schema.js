// Schema Validation Utilities
// For validating models and their fields at the schema level
// Schema validator for complete models
export class SchemaValidator {
    constructor(modelName) {
        this.modelName = modelName;
        this.validators = [];
    }
    addValidator(validator) {
        this.validators.push(validator);
    }
    async validate(data, context) {
        const errors = [];
        const validationContext = {
            modelName: this.modelName,
            ...context,
        };
        for (const validator of this.validators) {
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
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                errors.push(`Validation error in ${validationContext.modelName}: ${errorMessage}`);
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
}
// Field validator wrapper with context
export class FieldValidatorWrapper {
    constructor(validators, fieldName, modelName) {
        this.validators = validators;
        this.fieldName = fieldName;
        this.modelName = modelName;
    }
    async validate(value) {
        const errors = [];
        const context = {
            modelName: this.modelName,
            fieldName: this.fieldName,
            path: [this.fieldName],
        };
        for (const validator of this.validators) {
            try {
                if (typeof validator === "function") {
                    const result = await validator(value);
                    if (result !== true) {
                        const message = typeof result === "string" ? result : "Validation failed";
                        errors.push(`${this.fieldName}: ${message}`);
                    }
                }
                else if (validator &&
                    typeof validator === "object" &&
                    "~standard" in validator) {
                    const standardValidator = validator;
                    const result = await standardValidator["~standard"].validate(value);
                    if ("issues" in result) {
                        errors.push(...result.issues.map((issue) => `${this.fieldName}: ${issue.message}`));
                    }
                }
            }
            catch (error) {
                const errorMessage = error instanceof Error ? error.message : "Unknown error";
                errors.push(`${this.fieldName}: Validator error - ${errorMessage}`);
            }
        }
        return {
            valid: errors.length === 0,
            errors: errors.length > 0 ? errors : undefined,
        };
    }
}
// Utility to validate a complete record against schema
export async function validateRecord(data, fieldValidators, modelValidators, modelName) {
    const allErrors = [];
    // Validate individual fields
    for (const [fieldName, value] of Object.entries(data)) {
        if (fieldValidators[fieldName]) {
            const fieldValidator = new FieldValidatorWrapper(fieldValidators[fieldName], fieldName, modelName);
            const result = await fieldValidator.validate(value);
            if (!result.valid && result.errors) {
                allErrors.push(...result.errors);
            }
        }
    }
    // Validate at model level
    const schemaValidator = new SchemaValidator(modelName);
    modelValidators.forEach((validator) => schemaValidator.addValidator(validator));
    const modelResult = await schemaValidator.validate(data);
    if (!modelResult.valid && modelResult.errors) {
        allErrors.push(...modelResult.errors);
    }
    return {
        valid: allErrors.length === 0,
        errors: allErrors.length > 0 ? allErrors : undefined,
    };
}
//# sourceMappingURL=schema.js.map