import { StandardSchemaV1 } from "./standardSchema";
export interface ValidationResult {
    valid: boolean;
    errors?: string[] | undefined;
}
export type FieldValidator<T> = ((value: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<any, T>;
export type ModelValidator<T> = ((data: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<T, T>;
export type RelationValidator<T> = ((data: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<T, T>;
export declare class ValidationError extends Error {
    field?: string | undefined;
    errors?: string[] | undefined;
    constructor(message: string, field?: string | undefined, errors?: string[] | undefined);
}
export interface ValidationContext {
    field?: string;
    model?: string;
    path?: string[];
    value?: any;
}
export type ValidatorFunction<T> = (value: T, context?: ValidationContext) => boolean | string | Promise<boolean | string>;
export interface ComposableValidator<T> {
    validate: ValidatorFunction<T>;
    and: (other: ComposableValidator<T>) => ComposableValidator<T>;
    or: (other: ComposableValidator<T>) => ComposableValidator<T>;
}
//# sourceMappingURL=validators.d.ts.map