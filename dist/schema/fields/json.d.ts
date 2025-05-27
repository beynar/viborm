import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class JsonField<TData = any, T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<TData>> extends BaseField<T> {
    fieldType: "json";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): JsonField<TData, MakeNullable<T>>;
    list(): JsonField<TData, MakeList<T>>;
    id(): JsonField<TData, MakeId<T>>;
    unique(): JsonField<TData, MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): JsonField<TData, MakeDefault<T>>;
    validator(...validators: FieldValidator<TData>[]): this;
    validate(value: TData): Promise<any>;
}
export declare function json<T = any>(): JsonField<T, DefaultFieldState<T>>;
//# sourceMappingURL=json.d.ts.map