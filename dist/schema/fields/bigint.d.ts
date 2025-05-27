import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class BigIntField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<bigint>> extends BaseField<T> {
    fieldType: "bigInt";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): BigIntField<MakeNullable<T>>;
    list(): BigIntField<MakeList<T>>;
    id(): BigIntField<MakeId<T>>;
    unique(): BigIntField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): BigIntField<MakeDefault<T>>;
    validator(...validators: FieldValidator<bigint>[]): this;
    validate(value: bigint): Promise<any>;
}
export declare function bigint(): BigIntField<DefaultFieldState<bigint>>;
//# sourceMappingURL=bigint.d.ts.map