import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault } from "../../types/field-states.js";
import type { FieldValidator } from "../../types/validators.js";
export declare class BlobField<T extends FieldState<any, any, any, any, any, any> = DefaultFieldState<Uint8Array>> extends BaseField<T> {
    fieldType: "blob";
    private validators;
    constructor();
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): BlobField<MakeNullable<T>>;
    list(): BlobField<MakeList<T>>;
    id(): BlobField<MakeId<T>>;
    unique(): BlobField<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): BlobField<MakeDefault<T>>;
    validator(...validators: FieldValidator<Uint8Array>[]): this;
    validate(value: Uint8Array): Promise<any>;
}
export declare function blob(): BlobField<DefaultFieldState<Uint8Array>>;
//# sourceMappingURL=blob.d.ts.map