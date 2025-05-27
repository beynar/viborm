import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class BooleanField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<boolean>> extends BaseField<T> {
    fieldType: "boolean";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): BooleanField<MakeNullable<T>>;
    list(): BooleanField<MakeList<T>>;
    id(): BooleanField<MakeId<T>>;
    unique(): BooleanField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): BooleanField<MakeDefault<T>>;
    validator(...validators: FieldValidator<boolean>[]): this;
    validate(value: boolean): Promise<any>;
}
export declare function boolean(): BooleanField<DefaultFieldState<boolean>>;
//# sourceMappingURL=boolean.d.ts.map