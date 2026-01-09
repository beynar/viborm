import { C as DateTimeField, E as NativeType, S as DecimalField, T as BlobField, _ as StringField, b as FloatField, c as ManyToManyRelation, d as ModelState, f as UpdateState, g as VectorField, h as BigIntField, i as UniqueFields, n as RelationFields, o as ToOneRelation, p as Getter, r as ScalarFields, s as ToManyRelation, t as FieldRecord, u as Model, v as JsonField, w as BooleanField, x as EnumField, y as IntField } from "./helper-ssyhqKyM.mjs";
import { a as NotFoundError, c as createClient, o as VibORMClient, s as VibORMConfig } from "./index-CVpKlbOg.mjs";
import { At as EnumSchema, D as StringSchema, Gt as BigIntSchema, Lt as BooleanSchema, U as IntegerSchema, Vt as BlobSchema, W as NumberSchema, bt as IsoTimestampSchema, dt as JsonValue, ut as JsonSchema, x as VectorSchema } from "./index-DfCVh_Ql.mjs";

//#region src/schema/index.d.ts

/**
 * Main schema builder object
 * Use this to define models, fields, and relations
 *
 * Relations use a chainable API:
 * - ToOne (oneToOne, manyToOne): .fields(), .references(), .optional(), .onDelete(), .onUpdate()
 * - ToMany (oneToMany): minimal config - just .name() if needed
 * - ManyToMany: .through(), .A(), .B(), .onDelete(), .onUpdate()
 *
 * @example
 * ```ts
 * import { s } from "viborm";
 *
 * const user = s.model({
 *   id: s.string().id().ulid(),
 *   name: s.string(),
 *   email: s.string().unique(),
 *   posts: s.oneToMany(() => post),
 *   profile: s.oneToOne(() => profile).optional(),
 * }).map("users");
 *
 * const post = s.model({
 *   id: s.string().id().ulid(),
 *   authorId: s.string(),
 *   author: s.manyToOne(() => user).fields("authorId").references("id"),
 * }).map("posts");
 * ```
 */
declare const s: {
  model: <TFields extends FieldRecord>(fields: TFields) => Model<UpdateState<ModelState, {
    fields: TFields;
    scalars: ScalarFields<TFields>;
    relations: RelationFields<TFields>;
    uniques: UniqueFields<TFields>;
    omit: undefined;
  }>>;
  string: (nativeType?: NativeType) => StringField<{
    type: "string";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: StringSchema<string, string>;
  }>;
  boolean: (nativeType?: NativeType) => BooleanField<{
    type: "boolean";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: BooleanSchema<boolean, boolean>;
  }>;
  int: (nativeType?: NativeType) => IntField<{
    type: "int";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: IntegerSchema<number, number>;
  }>;
  float: (nativeType?: NativeType) => FloatField<{
    type: "float";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: NumberSchema<number, number>;
  }>;
  decimal: (nativeType?: NativeType) => DecimalField<{
    type: "decimal";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: NumberSchema<number, number>;
  }>;
  bigInt: (nativeType?: NativeType) => BigIntField<{
    type: "bigint";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: BigIntSchema<bigint, bigint>;
  }>;
  dateTime: (nativeType?: NativeType) => DateTimeField<{
    type: "datetime";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: IsoTimestampSchema<string | Date, string>;
  }>;
  json: (nativeType?: NativeType) => JsonField<{
    type: "json";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: JsonSchema<JsonValue, JsonValue>;
  }>;
  blob: (nativeType?: NativeType) => BlobField<{
    type: "blob";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: BlobSchema<Uint8Array<ArrayBufferLike>, Uint8Array<ArrayBufferLike>>;
  }>;
  enum: <const T extends string[]>(values: T, nativeType?: NativeType) => EnumField<T, {
    type: "enum";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: EnumSchema<T, T[number], T[number]>;
  }>;
  vector: (nativeType?: NativeType) => VectorField<{
    type: "vector";
    nullable: boolean;
    array: boolean;
    hasDefault: boolean;
    isId: boolean;
    isUnique: boolean;
    default: undefined;
    autoGenerate: undefined;
    schema: undefined;
    columnName: undefined;
    optional: boolean;
    base: VectorSchema<number[], number[]> & {
      dimensions?: number;
    };
  }>;
  oneToOne: <G extends Getter>(getter: G) => ToOneRelation<{
    type: "oneToOne";
    getter: G;
  }>;
  manyToOne: <G extends Getter>(getter: G) => ToOneRelation<{
    type: "manyToOne";
    getter: G;
  }>;
  oneToMany: <G extends Getter>(getter: G) => ToManyRelation<{
    type: "oneToMany";
    getter: G;
  }>;
  manyToMany: <G extends Getter>(getter: G) => ManyToManyRelation<{
    type: "manyToMany";
    getter: G;
  }>;
};
//#endregion
export { NotFoundError, type VibORMClient, type VibORMConfig, createClient, s };
//# sourceMappingURL=index.d.mts.map