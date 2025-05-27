import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault, NumberAutoMethods } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class NumberField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<number>> extends BaseField<T> {
    fieldType: "int" | "float" | "decimal";
    private validators;
    constructor(fieldType?: "int" | "float" | "decimal");
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): NumberField<MakeNullable<T>>;
    list(): NumberField<MakeList<T>>;
    id(): NumberField<MakeId<T>>;
    unique(): NumberField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): NumberField<MakeDefault<T>>;
    validator(...validators: FieldValidator<number>[]): this;
    get auto(): NumberAutoMethods<NumberField<T>>;
    validate(value: number): Promise<any>;
}
export declare function int(): NumberField<DefaultFieldState<number>>;
export declare function float(): NumberField<DefaultFieldState<number>>;
export declare function decimal(): NumberField<DefaultFieldState<number>>;
//# sourceMappingURL=number.d.ts.map