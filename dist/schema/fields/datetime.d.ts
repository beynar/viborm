import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class DateTimeField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<Date>> extends BaseField<T> {
    fieldType: "dateTime";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): DateTimeField<MakeNullable<T>>;
    list(): DateTimeField<MakeList<T>>;
    id(): DateTimeField<MakeId<T>>;
    unique(): DateTimeField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): DateTimeField<MakeDefault<T>>;
    validator(...validators: FieldValidator<Date>[]): this;
    get auto(): {
        uuid: () => never;
        ulid: () => never;
        nanoid: () => never;
        cuid: () => never;
        increment: () => never;
        now: () => this;
        updatedAt: () => this;
    };
    validate(value: Date): Promise<any>;
}
export declare function datetime(): DateTimeField<DefaultFieldState<Date>>;
//# sourceMappingURL=datetime.d.ts.map