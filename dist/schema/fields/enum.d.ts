import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class EnumField<TEnum extends readonly (string | number)[], T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<TEnum[number]>> extends BaseField<T> {
    fieldType: "enum";
    readonly enumValues: TEnum;
    private validators;
    constructor(values: TEnum);
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): EnumField<TEnum, MakeNullable<T>>;
    list(): EnumField<TEnum, MakeList<T>>;
    id(): EnumField<TEnum, MakeId<T>>;
    unique(): EnumField<TEnum, MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): EnumField<TEnum, MakeDefault<T>>;
    validator(...validators: FieldValidator<TEnum[number]>[]): this;
    validate(value: TEnum[number]): Promise<any>;
}
export declare function enumField<TEnum extends readonly (string | number)[]>(values: TEnum): EnumField<TEnum, DefaultFieldState<TEnum[number]>>;
//# sourceMappingURL=enum.d.ts.map