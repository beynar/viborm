import { BaseField } from "./base.js";
import type { FieldState, DefaultFieldState, MakeNullable, MakeList, MakeId, MakeDefault } from "../../types/field-states.js";
import type { StandardSchemaV1 } from "../../types/standardSchema.js";
import type { ValidationResult } from "../../types/validators.js";
export declare class JsonField<TData = any, T extends FieldState<TData, any, any, any, any, any> = DefaultFieldState<TData>> extends BaseField<T> {
    fieldType: "json";
    private schema;
    constructor(schema?: StandardSchemaV1<any, TData>);
    protected createInstance<U extends FieldState<any, any, any, any, any, any>>(): BaseField<U>;
    nullable(): JsonField<TData, MakeNullable<T>>;
    list(): JsonField<TData, MakeList<T>>;
    id(): JsonField<TData, MakeId<T>>;
    default(value: T["BaseType"] | (() => T["BaseType"])): JsonField<TData, MakeDefault<T>>;
    validate(value: TData): Promise<ValidationResult>;
    getSchema(): StandardSchemaV1<any, TData> | undefined;
}
export declare function json(): JsonField<any, DefaultFieldState<any>>;
export declare function json<TSchema extends StandardSchemaV1<any, any>>(schema: TSchema): JsonField<StandardSchemaV1.InferOutput<TSchema>, DefaultFieldState<StandardSchemaV1.InferOutput<TSchema>>>;
//# sourceMappingURL=json.d.ts.map