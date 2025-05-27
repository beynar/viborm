import type { FieldValidator, ModelValidator, ValidationResult } from "../types/index.js";
export declare function validateField<T>(value: T, validators: FieldValidator<T>[]): Promise<ValidationResult>;
export declare function validateModel<T>(data: T, validators: ModelValidator<T>[]): Promise<ValidationResult>;
export declare function composeValidators<T>(...validators: FieldValidator<T>[]): FieldValidator<T>;
export declare function regexValidator(pattern: RegExp, message?: string): FieldValidator<string>;
export declare function lengthValidator(min?: number, max?: number, message?: string): FieldValidator<string>;
export declare function rangeValidator(min?: number, max?: number, message?: string): FieldValidator<number>;
export declare function enumValidator<T extends string | number>(values: readonly T[], message?: string): FieldValidator<T>;
export declare const emailValidator: FieldValidator<string>;
export declare const urlValidator: FieldValidator<string>;
export declare const uuidValidator: FieldValidator<string>;
export declare const ulidValidator: FieldValidator<string>;
//# sourceMappingURL=validators.d.ts.map