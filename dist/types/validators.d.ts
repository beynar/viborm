export interface StandardSchemaV1<Input = unknown, Output = Input> {
    readonly "~standard": {
        readonly version: 1;
        readonly vendor: string;
        readonly validate: (value: unknown) => {
            value: Output;
        } | {
            issues: Array<{
                message: string;
            }>;
        } | Promise<{
            value: Output;
        } | {
            issues: Array<{
                message: string;
            }>;
        }>;
    };
}
export interface ValidationResult {
    valid: boolean;
    errors?: string[] | undefined;
}
export type FieldValidator<T> = ((value: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<T, T>;
export type ModelValidator<T> = ((data: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<T, T>;
export type RelationValidator<T> = ((data: T) => boolean | string | Promise<boolean | string>) | StandardSchemaV1<T, T>;
export declare const BuiltInValidators: {
    email: RegExp;
    url: RegExp;
    uuid: RegExp;
    ulid: RegExp;
    ipv4: RegExp;
    ipv6: RegExp;
    phone: RegExp;
    creditCard: RegExp;
    hexColor: RegExp;
    base64: RegExp;
    jwt: RegExp;
};
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