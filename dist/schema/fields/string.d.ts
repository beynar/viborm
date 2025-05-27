import { BaseField } from "./base.js";
import type { ValidationResult } from "../../types/index.js";
export declare class StringField<T extends string = string> extends BaseField<T> {
    private regexPattern?;
    private minLength?;
    private maxLength?;
    constructor();
    protected createInstance<U>(): BaseField<U>;
    regex(pattern: RegExp): this;
    min(length: number): this;
    max(length: number): this;
    get auto(): {
        uuid: () => this;
        ulid: () => this;
        nanoid: () => this;
        cuid: () => this;
    };
    validate(value: T, ...validators: import("../../types/index.js").FieldValidator<T>[]): Promise<ValidationResult>;
    protected copyPropertiesTo(target: BaseField<any>): void;
    "~getRegexPattern"(): RegExp | undefined;
    "~getMinLength"(): number | undefined;
    "~getMaxLength"(): number | undefined;
}
//# sourceMappingURL=string.d.ts.map