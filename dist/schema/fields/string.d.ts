import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class StringField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<string>> extends BaseField<T> {
    fieldType: "string";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): StringField<MakeNullable<T>>;
    list(): StringField<MakeList<T>>;
    id(): StringField<MakeId<T>>;
    unique(): StringField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): StringField<MakeDefault<T>>;
    validator(...validators: FieldValidator<string>[]): this;
    validate(value: string): Promise<any>;
}
export declare function string(): StringField<DefaultFieldState<string>>;
//# sourceMappingURL=string.d.ts.map