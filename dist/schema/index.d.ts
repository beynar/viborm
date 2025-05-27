import { Model } from "./model.js";
import { BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, type Field } from "./field.js";
import { Relation } from "./relation.js";
export declare class SchemaBuilder {
    model<TName extends string, TFields extends Record<string, Field | Relation<any>>>(name: TName, fields: TFields): Model<TFields>;
    string(): StringField;
    boolean(): BooleanField;
    int(): NumberField;
    bigInt(): BigIntField;
    float(): NumberField;
    decimal(precision: number, scale: number): NumberField;
    dateTime(): DateTimeField;
    json<T = any>(): JsonField<T>;
    blob(): BlobField;
    enum<TEnum extends readonly (string | number)[]>(values: TEnum): EnumField<TEnum>;
    get relation(): {
        one: <T>(target: () => T) => Relation<T>;
        many: <T>(target: () => T) => Relation<T[]>;
    };
}
export declare const s: SchemaBuilder;
export { Model, BaseField, StringField, NumberField, BooleanField, BigIntField, DateTimeField, JsonField, BlobField, EnumField, Relation, };
export type { Field };
//# sourceMappingURL=index.d.ts.map