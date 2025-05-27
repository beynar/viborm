import { Model } from "./model.js";
import { BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, type Field } from "./fields/index.js";
import { json } from "./fields/json.js";
import { Relation } from "./relation.js";
export declare class SchemaBuilder {
    model<TName extends string, TFields extends Record<string, Field | Relation<any>>>(name: TName, fields: TFields): Model<TFields>;
    string(): StringField<import("../index.js").DefaultFieldState<string>>;
    boolean(): BooleanField<import("../index.js").DefaultFieldState<boolean>>;
    int(): NumberField<import("../index.js").DefaultFieldState<number>>;
    bigInt(): BigIntField<import("../index.js").DefaultFieldState<bigint>>;
    float(): NumberField<import("../index.js").DefaultFieldState<number>>;
    decimal(): NumberField<import("../index.js").DefaultFieldState<number>>;
    dateTime(): DateTimeField<import("../index.js").DefaultFieldState<Date>>;
    json(): ReturnType<typeof json>;
    json<TSchema extends import("../types/standardSchema.js").StandardSchemaV1<any, any>>(schema: TSchema): ReturnType<typeof json<TSchema>>;
    blob(): BlobField<import("../index.js").DefaultFieldState<Uint8Array<ArrayBufferLike>>>;
    enum<TEnum extends readonly (string | number)[]>(values: TEnum): EnumField<TEnum, import("../index.js").DefaultFieldState<TEnum[number]>>;
    get relation(): {
        one: <T>(target: () => T) => Relation<T>;
        many: <T>(target: () => T) => Relation<T[]>;
    };
}
export declare const s: SchemaBuilder;
export { Model, BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, Relation, };
export type { Field };
//# sourceMappingURL=index.d.ts.map