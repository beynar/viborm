import type { ValidationResult } from "../types/index.js";
export declare class RuntimeValidationError extends Error {
    field?: string | undefined;
    errors?: string[] | undefined;
    constructor(message: string, field?: string | undefined, errors?: string[] | undefined);
}
export declare class ValidationAggregator {
    private operation?;
    private results;
    private context;
    constructor(operation?: string | undefined);
    addResult(result: ValidationResult, context?: string): void;
    getAggregatedResult(): ValidationResult;
    throwIfInvalid(): void;
}
export declare function coerceValue(value: any, targetType: string): any;
export declare function transformValue<T>(value: any, transformer: (value: any) => T, fieldName?: string): T;
export declare function sanitizeInput(data: Record<string, any>): Record<string, any>;
export declare function isEmpty(value: any): boolean;
export declare function validateRequiredFields(data: Record<string, any>, requiredFields: string[]): ValidationResult;
//# sourceMappingURL=runtime.d.ts.map