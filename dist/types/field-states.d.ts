import type { AutoGenerateType } from "./scalars.js";
export interface FieldState<T = any, IsNullable extends boolean = boolean, IsList extends boolean = boolean, IsId extends boolean = boolean, IsUnique extends boolean = boolean, HasDefault extends boolean = boolean> {
    BaseType: T;
    IsNullable: IsNullable;
    IsList: IsList;
    IsId: IsId;
    IsUnique: IsUnique;
    HasDefault: HasDefault;
    AutoGenerate: AutoGenerateType | false;
}
export type DefaultFieldState<T> = FieldState<T, false, false, false, false, false>;
export type MakeNullable<T extends FieldState<any, any, any, any, any, any>> = FieldState<T["BaseType"], true, T["IsList"], T["IsId"], T["IsUnique"], T["HasDefault"]>;
export type MakeList<T extends FieldState<any, any, any, any, any, any>> = FieldState<T["BaseType"], T["IsNullable"], true, T["IsId"], T["IsUnique"], T["HasDefault"]>;
export type MakeId<T extends FieldState<any, any, any, any, any, any>> = FieldState<T["BaseType"], T["IsNullable"], T["IsList"], true, T["IsUnique"], T["HasDefault"]>;
export type MakeUnique<T extends FieldState<any, any, any, any, any, any>> = FieldState<T["BaseType"], T["IsNullable"], T["IsList"], T["IsId"], true, T["HasDefault"]>;
export type MakeDefault<T extends FieldState<any, any, any, any, any, any>> = FieldState<T["BaseType"], T["IsNullable"], T["IsList"], T["IsId"], T["IsUnique"], true>;
export type MakeAuto<T extends FieldState<any, any, any, any, any, any>, A extends AutoGenerateType> = FieldState<T["BaseType"], T["IsNullable"], T["IsList"], T["IsId"], T["IsUnique"], true> & {
    AutoGenerate: A;
};
export type SmartInferType<T extends FieldState<any, any, any, any, any, any>> = T["IsId"] extends true ? SmartInferNonNullable<T> : T["AutoGenerate"] extends AutoGenerateType ? SmartInferNonNullable<T> : T["HasDefault"] extends true ? SmartInferNonNullable<T> : T["IsList"] extends true ? T["IsNullable"] extends true ? T["BaseType"][] | null : T["BaseType"][] : T["IsNullable"] extends true ? T["BaseType"] | null : T["BaseType"];
type SmartInferNonNullable<T extends FieldState<any, any, any, any, any, any>> = T["IsList"] extends true ? T["BaseType"][] : T["BaseType"];
export type InferInputType<T extends FieldState<any, any, any, any, any, any>> = T["AutoGenerate"] extends AutoGenerateType ? SmartInferOptional<T> : T["HasDefault"] extends true ? SmartInferOptional<T> : SmartInferType<T>;
type SmartInferOptional<T extends FieldState<any, any, any, any, any, any>> = T["IsList"] extends true ? T["BaseType"][] | undefined : T["BaseType"] | undefined;
export type InferStorageType<T extends FieldState<any, any, any, any, any, any>> = SmartInferType<T>;
export type InferType<T extends FieldState<any, any, any, any, any, any>> = SmartInferType<T>;
export type ValidateFieldState<T extends FieldState<any, any, any, any, any, any>> = {
    readonly __WARNING_ID_FIELDS_CANNOT_BE_NULLABLE: T["IsId"] extends true ? T["IsNullable"] extends true ? "❌ ID fields cannot be nullable - this setting will be ignored" : "✅ Valid ID field configuration" : "✅ Non-ID field";
    readonly __WARNING_AUTO_FIELDS_ARE_NON_NULLABLE: T["AutoGenerate"] extends AutoGenerateType ? T["IsNullable"] extends true ? "⚠️ Auto-generated fields are never null - nullable setting ignored" : "✅ Valid auto-generated field configuration" : "✅ Non-auto field";
    readonly __WARNING_DEFAULT_FIELDS_ARE_NON_NULLABLE: T["HasDefault"] extends true ? T["IsNullable"] extends true ? "⚠️ Fields with defaults are non-nullable - nullable setting ignored" : "✅ Valid default field configuration" : "✅ Field without default";
};
export interface BaseFieldType<T extends FieldState<any, any, any, any, any, any>> {
    readonly __fieldState: T;
    readonly infer: InferType<T>;
    readonly inferInput: InferInputType<T>;
    readonly inferStorage: InferStorageType<T>;
    readonly validateState: ValidateFieldState<T>;
    nullable(): BaseFieldType<MakeNullable<T>>;
    list(): BaseFieldType<MakeList<T>>;
    id(): BaseFieldType<MakeId<T>>;
    unique(): BaseFieldType<MakeUnique<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): BaseFieldType<MakeDefault<T>>;
}
export type ExtractFieldType<F> = F extends BaseFieldType<infer T> ? T : never;
export type ExtractInferredType<F> = F extends BaseFieldType<infer T> ? InferType<T> : never;
export type ExtractInputType<F> = F extends BaseFieldType<infer T> ? InferInputType<T> : never;
export type ExtractStorageType<F> = F extends BaseFieldType<infer T> ? InferStorageType<T> : never;
export {};
//# sourceMappingURL=field-states.d.ts.map