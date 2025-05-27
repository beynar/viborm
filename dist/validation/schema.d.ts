import type { ModelValidator, FieldValidator, ValidationResult } from "../types/index.js";
export interface SchemaValidationContext {
    modelName: string;
    fieldName?: string;
    path?: string[];
}
export declare class SchemaValidator<T> {
    private modelName;
    private validators;
    constructor(modelName: string);
    addValidator(validator: ModelValidator<T>): void;
    validate(data: T, context?: SchemaValidationContext): Promise<ValidationResult>;
}
export declare class FieldValidatorWrapper<T> {
    private validators;
    private fieldName;
    private modelName;
    constructor(validators: FieldValidator<T>[], fieldName: string, modelName: string);
    validate(value: T): Promise<ValidationResult>;
}
export declare function validateRecord<T extends Record<string, any>>(data: T, fieldValidators: Record<string, FieldValidator<any>[]>, modelValidators: ModelValidator<T>[], modelName: string): Promise<ValidationResult>;
//# sourceMappingURL=schema.d.ts.map