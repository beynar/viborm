import { BaseField } from "./base.js";
import type { ValidationResult } from "../../types/index.js";
export declare class NumberField<T extends number = number> extends BaseField<T> {
    private minValue?;
    private maxValue?;
    private precision?;
    private scale?;
    constructor(fieldType?: "int" | "float" | "decimal");
    protected createInstance<U>(): BaseField<U>;
    min(value: number): this;
    max(value: number): this;
    setPrecision(precision: number, scale?: number): this;
    get auto(): {
        increment: () => this;
    };
    validate(value: T, ...validators: import("../../types/index.js").FieldValidator<T>[]): Promise<ValidationResult>;
    protected copyPropertiesTo(target: BaseField<any>): void;
    "~getMinValue"(): number | undefined;
    "~getMaxValue"(): number | undefined;
    "~getPrecision"(): number | undefined;
    "~getScale"(): number | undefined;
}
//# sourceMappingURL=number.d.ts.map