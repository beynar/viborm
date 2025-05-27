import type { ScalarFieldType, FieldValidator, ValidationResult, AutoGenerateType } from "../../types/index.js";
import type { FieldState, MakeNullable, MakeList, MakeId, MakeUnique, MakeDefault, InferType, InferInputType, InferStorageType, InferDefaultValueType, ValidateFieldState, BaseFieldType } from "../../types/field-states.js";
export declare abstract class BaseField<T extends FieldState<any, any, any, any, any, any> = any> implements BaseFieldType<T> {
    readonly __fieldState: T;
    fieldType?: ScalarFieldType | undefined;
    isOptional: boolean;
    isUnique: boolean;
    isId: boolean;
    isList: boolean;
    defaultValue?: InferDefaultValueType<T> | (() => InferDefaultValueType<T>) | undefined;
    autoGenerate?: AutoGenerateType | undefined;
    constructor();
    nullable(): BaseFieldType<MakeNullable<T>>;
    default(value: InferDefaultValueType<T> | (() => InferDefaultValueType<T>)): BaseFieldType<MakeDefault<T>>;
    unique(): BaseFieldType<MakeUnique<T>>;
    id(): BaseFieldType<MakeId<T>>;
    list(): BaseFieldType<MakeList<T>>;
    protected abstract createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    validate(value: T["BaseType"], ...validators: FieldValidator<T["BaseType"]>[]): Promise<ValidationResult>;
    protected validateType(value: any): boolean;
    protected copyPropertiesTo(target: BaseField<any>): void;
    get infer(): InferType<T>;
    get inferInput(): InferInputType<T>;
    get inferStorage(): InferStorageType<T>;
    get validateState(): ValidateFieldState<T>;
}
//# sourceMappingURL=base.d.ts.map