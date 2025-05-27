import type { ScalarFieldType, FieldValidator, ValidationResult } from "../../types/index.js";
export declare abstract class BaseField<T = any> {
    protected fieldType?: ScalarFieldType | undefined;
    protected isOptional: boolean;
    protected isUnique: boolean;
    protected isId: boolean;
    protected isList: boolean;
    protected defaultValue?: T | (() => T) | undefined;
    protected autoGenerate?: "uuid" | "ulid" | "nanoid" | "cuid" | "increment" | "now" | "updatedAt" | undefined;
    constructor();
    nullable(): this;
    default(value: T | (() => T)): this;
    unique(): this;
    id(): this;
    list(): BaseField<T[]>;
    protected abstract createInstance<U>(): BaseField<U>;
    validate(value: T, ...validators: FieldValidator<T>[]): Promise<ValidationResult>;
    protected validateType(value: any): boolean;
    protected copyPropertiesTo(target: BaseField<any>): void;
    "~getType"(): ScalarFieldType | undefined;
    get infer(): T;
    "~getIsOptional"(): boolean;
    "~getIsUnique"(): boolean;
    "~getIsId"(): boolean;
    "~getIsList"(): boolean;
    "~getDefaultValue"(): T | (() => T) | undefined;
    "~getAutoGenerate"(): string | undefined;
}
//# sourceMappingURL=base.d.ts.map