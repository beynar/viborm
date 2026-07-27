// =============================================================================
// VibORM Validation - Runtime and Type-Level Namespace
// =============================================================================

import type { JsonNullKind } from "@schema/json-null";
import type { ScalarType } from "@schema/scalars/common";
import type {
  ComputeInput,
  ComputeOutput,
  InferInput,
  InferOutput,
  ScalarOptions,
  VibSchema,
} from "../types";
import type { ArraySchema } from "./array";
import { array } from "./array";
import type { BigIntSchema } from "./bigint";
import { bigint } from "./bigint";
import type { BlobSchema } from "./blob";
import { blob } from "./blob";
import type { BooleanSchema } from "./boolean";
import { boolean } from "./boolean";
import type { DateSchema } from "./date";
import { date } from "./date";
import type { DecimalInput, DecimalOutput, DecimalSchema } from "./decimal";
import { decimal } from "./decimal";
import type { EnumSchema } from "./enum";
import { enum_ } from "./enum";
import type { FieldRefOrSchema, NoFieldRefSchema } from "./field-ref";
import { fieldRefOr, noFieldRef } from "./field-ref";
import type { ComputeEntriesFromObject } from "./from-object";
import { fromObject } from "./from-object";
import type { IsoDateSchema, IsoTimeSchema, IsoTimestampSchema } from "./iso";
import { isoDate, isoTime, isoTimestamp } from "./iso";
import type { JsonSchema, JsonValue } from "./json";
import { json } from "./json";
import type { JsonNullOrSchema, JsonWriteSchema } from "./json-null";
import { jsonNullOr, jsonWrite } from "./json-null";
import { lazy, lazyRef } from "./lazy";
import type { LiteralSchema, LiteralValue } from "./literal";
import { literal } from "./literal";
import type { NullableSchema } from "./nullable";
import { maybeNullable, nullable } from "./nullable";
import type { IntegerSchema, NumberSchema } from "./number";
import { integer, number } from "./number";
import type { ObjectOptions, ObjectSchema } from "./object";
import { object } from "./object";
import { omit } from "./omit";
import type { OptionalSchema, WrappableSchema } from "./optional";
import { optional } from "./optional";
import type { PipeAction, PipeSchema } from "./pipe";
import { pipe, transform as transformAction } from "./pipe";
import type { PointSchema } from "./point";
import { point } from "./point";
import type { ComputeEntriesFromKeys, RecordSchema } from "./record";
import { fromKeys, record } from "./record";
import { refused } from "./refused";
import { shorthandArray, shorthandFilter, shorthandUpdate } from "./shorthand";
import { singleOrArray } from "./single-or-array";
import type { StringSchema } from "./string";
import { string } from "./string";
import type { TransformSchema } from "./transform";
import { coerce, map } from "./transform";
import type { UnionSchema } from "./union";
import { union } from "./union";
import type { VectorSchema } from "./vector";
import { vector } from "./vector";

// =============================================================================
// Runtime Namespace (v.string(), v.number(), etc.)
// =============================================================================

/**
 * VibORM validation namespace.
 *
 * @example
 * import { v } from "viborm/validation";
 *
 * const user = v.object({
 *   name: v.string(),
 *   age: v.number({ optional: true }),
 *   email: v.string(),
 *   createdAt: v.date(),
 * });
 *
 * // Circular references use thunks
 * const node = v.object({
 *   value: v.string(),
 *   parent: () => node,  // Thunk for self-reference
 * });
 */
export const v = {
  // Scalars
  string,
  number,
  integer,
  boolean,
  bigint,
  decimal,
  literal,
  enum: enum_,
  json,
  // Date & Time
  date,
  isoTimestamp,
  isoDate,
  isoTime,
  // Blob, Vector, Point
  blob,
  vector,
  point,
  // Wrappers
  array,
  nullable,
  maybeNullable,
  optional,
  // Objects
  object,
  omit,
  fromObject,
  // Composition
  union,
  pipe,
  transformAction,
  record,
  fromKeys,
  // Transform wrappers
  coerce,
  map,
  // Lazy evaluation
  lazy,
  lazyRef,
  // Single or array
  singleOrArray,
  // Shorthand coercions
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
  // Field references (Prisma FieldRef parity)
  fieldRefOr,
  noFieldRef,
  // JSON null sentinels (Prisma DbNull/JsonNull/AnyNull parity)
  jsonNullOr,
  jsonWrite,
  // Keys that exist only to explain why they are refused
  refused,
} as const;

export default v;

// =============================================================================
// Type-Level Namespace (V.String, V.Number, etc.)
// =============================================================================

/**
 * V Namespace - Type-level schema constructors for explicit type annotations.
 *
 * These mirror the runtime v.* functions but produce types directly without
 * needing to serialize the full schema structure in .d.ts files.
 *
 * @example
 * ```typescript
 * // In a .d.ts file:
 * import type { V } from "@validation";
 *
 * export type UserSchema = V.Object<{
 *   id: V.String;
 *   name: V.String<{ optional: true }>;
 *   age: V.Number;
 * }>;
 * ```
 */
export namespace V {
  // =========================================================================
  // Scalar Types
  // =========================================================================

  /**
   * Type-level string schema.
   * @example V.String - Required string
   * @example V.String<{ optional: true }> - Optional string
   * @example V.String<{ nullable: true }> - Nullable string
   * @example V.String<{ array: true }> - Array of strings
   */
  export type String<
    Opts extends ScalarOptions<string, any> | undefined = undefined,
  > = StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;

  /**
   * Type-level number schema.
   * @example V.Number - Required number
   * @example V.Number<{ optional: true }> - Optional number
   */
  export type Number<
    Opts extends ScalarOptions<number, any> | undefined = undefined,
  > = NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;

  /**
   * Type-level integer schema.
   */
  export type Integer<
    Opts extends ScalarOptions<number, any> | undefined = undefined,
  > = IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;

  /**
   * Type-level decimal schema. Input and output differ on purpose: a decimal
   * accepts `string | number` and always reads back as an exact `string`.
   * @example V.Decimal - Required decimal
   * @example V.Decimal<{ nullable: true }> - Nullable decimal
   */
  export type Decimal<
    Opts extends ScalarOptions<DecimalInput, any> | undefined = undefined,
  > = DecimalSchema<
    ComputeInput<DecimalInput, Opts>,
    ComputeOutput<DecimalOutput, Opts>
  >;

  /**
   * Type-level boolean schema.
   */
  export type Boolean<
    Opts extends ScalarOptions<boolean, any> | undefined = undefined,
  > = BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;

  /**
   * Type-level bigint schema.
   */
  export type BigInt<
    Opts extends ScalarOptions<bigint, any> | undefined = undefined,
  > = BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;

  // =========================================================================
  // Date & Time Types
  // =========================================================================

  /**
   * Type-level Date schema (JavaScript Date object).
   */
  export type Date<
    Opts extends ScalarOptions<globalThis.Date, any> | undefined = undefined,
  > = DateSchema<
    ComputeInput<globalThis.Date, Opts>,
    ComputeOutput<globalThis.Date, Opts>
  >;

  /**
   * Type-level ISO timestamp schema (accepts string | Date, outputs string).
   */
  export type IsoTimestamp<
    Opts extends ScalarOptions<string, any> | undefined = undefined,
  > = IsoTimestampSchema<
    ComputeInput<string | globalThis.Date, Opts>,
    ComputeOutput<string, Opts>
  >;

  /**
   * Type-level ISO date schema (accepts string | Date, outputs string YYYY-MM-DD).
   */
  export type IsoDate<
    Opts extends ScalarOptions<string, any> | undefined = undefined,
  > = IsoDateSchema<
    ComputeInput<string | globalThis.Date, Opts>,
    ComputeOutput<string, Opts>
  >;

  /**
   * Type-level ISO time schema (accepts string | Date, outputs string HH:MM:SS).
   */
  export type IsoTime<
    Opts extends ScalarOptions<string, any> | undefined = undefined,
  > = IsoTimeSchema<
    ComputeInput<string | globalThis.Date, Opts>,
    ComputeOutput<string, Opts>
  >;

  // =========================================================================
  // Special Types
  // =========================================================================

  /**
   * Type-level JSON schema.
   */
  export type Json<
    Opts extends ScalarOptions<JsonValue, any> | undefined = undefined,
  > = JsonSchema<ComputeInput<JsonValue, Opts>, ComputeOutput<JsonValue, Opts>>;

  /**
   * Type-level blob schema (Uint8Array or Buffer-like).
   */
  export type Blob<
    Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined,
  > = BlobSchema<
    ComputeInput<Uint8Array, Opts>,
    ComputeOutput<Uint8Array, Opts>
  >;

  /**
   * Type-level vector schema (number array for embeddings).
   */
  export type Vector<
    Opts extends ScalarOptions<number[], any> | undefined = undefined,
  > = VectorSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>>;

  /**
   * Type-level point schema (geographic coordinates).
   */
  export type Point<
    Opts extends
      | ScalarOptions<{ x: number; y: number }, any>
      | undefined = undefined,
  > = PointSchema<
    ComputeInput<{ x: number; y: number }, Opts>,
    ComputeOutput<{ x: number; y: number }, Opts>
  >;

  // =========================================================================
  // Composition Types
  // =========================================================================

  /**
   * Type-level object schema.
   * @example V.Object<{ name: V.String; age: V.Number }>
   * @example V.Object<{ name: V.String }, { partial: false }> - All required
   */
  export type Object<
    TEntries,
    TOpts extends ObjectOptions | undefined = undefined,
  > = ObjectSchema<TEntries, TOpts>;

  /**
   * Type-level omit schema - creates a new object schema with keys removed.
   * @example V.Omit<UserSchema, ["password"]> - User without password field
   */
  export type Omit<
    TSchema extends ObjectSchema<any, any>,
    TKeys extends readonly (keyof TSchema["entries"])[],
  > = ObjectSchema<TSchema["entries"], TSchema["options"] & { omit: TKeys }>;

  /**
   * Type-level from object schema.
   * @example V.FromObject<{ name: V.String }, "name"> - Object with name field
   */
  export type FromObject<
    TObject extends Record<string, any>,
    TPath extends string,
    TOpts extends ObjectOptions | undefined = undefined,
  > = ObjectSchema<ComputeEntriesFromObject<TObject, TPath>, TOpts>;

  export type FromKeys<
    TKeys extends string[],
    TSchema extends VibSchema<any, any>,
    TOpts extends ObjectOptions | undefined = undefined,
  > = ObjectSchema<ComputeEntriesFromKeys<TKeys, TSchema>, TOpts>;

  /**
   * Type-level array schema.
   * @example V.Array<V.String> - Array of strings
   */
  export type Array<TItem extends VibSchema<any, any>> = ArraySchema<TItem>;

  /**
   * Type-level union schema.
   * @example V.Union<[V.String, V.Number]>
   */
  export type Union<TOptions extends readonly VibSchema<any, any>[]> =
    UnionSchema<TOptions>;

  /**
   * Type-level enum schema.
   * @example V.Enum<["active", "inactive", "pending"]>
   */
  export type Enum<
    TValues extends string[],
    Opts extends ScalarOptions<TValues[number], any> | undefined = undefined,
  > = EnumSchema<
    TValues,
    ComputeInput<TValues[number], Opts>,
    ComputeOutput<TValues[number], Opts>
  >;

  /**
   * Type-level literal schema.
   * @example V.Literal<"active">
   */
  export type Literal<TValue extends LiteralValue> = LiteralSchema<TValue>;

  /**
   * Type-level record schema (dictionary with uniform value type).
   * @example V.Record<V.String, V.Number>
   */
  export type VRecord<
    TKey extends VibSchema<any, string>,
    TValue extends VibSchema<any, any>,
  > = RecordSchema<TKey, TValue>;

  // =========================================================================
  // Wrapper Types
  // =========================================================================

  /**
   * Type-level optional schema.
   * @example V.Optional<V.String> - string | undefined
   */
  export type Optional<
    TWrapped extends WrappableSchema,
    TDefault = undefined,
  > = OptionalSchema<TWrapped, TDefault>;

  /**
   * Type-level nullable schema.
   * @example V.Nullable<V.String> - string | null
   */
  export type Nullable<TWrapped extends VibSchema<any, any>> =
    NullableSchema<TWrapped>;

  export type MaybeNullable<
    TWrapped extends VibSchema<any, any>,
    TIsNullable extends boolean,
  > = TIsNullable extends true ? NullableSchema<TWrapped> : TWrapped;

  // =========================================================================
  // Transform Types
  // =========================================================================

  /**
   * Type-level transform schema.
   * @example V.Transform<string, number> - transforms string input to number output
   */
  export type Transform<TInput, TOutput> = TransformSchema<TInput, TOutput>;

  /**
   * Type-level pipe schema for chaining validations.
   * @example V.Pipe<V.String, [TrimAction, LowercaseAction]>
   */
  export type Pipe<
    TSchema extends VibSchema<any, any>,
    TActions extends readonly PipeAction<any, any>[],
  > = PipeSchema<TSchema, TActions>;

  export type Coerce<
    TWrapped extends VibSchema<any, any>,
    TOutput,
  > = TransformSchema<InferInput<TWrapped>, TOutput> & { wrapped: TWrapped };

  export type ShorthandFilter<TWrapped extends VibSchema<any, any>> = Coerce<
    TWrapped,
    { equals: TWrapped[" vibInferred"]["1"] }
  >;
  export type ShorthandUpdate<TWrapped extends VibSchema<any, any>> = Coerce<
    TWrapped,
    { set: TWrapped[" vibInferred"]["1"] }
  >;
  export type ShorthandArray<TWrapped extends VibSchema<any, any>> = Coerce<
    TWrapped,
    [TWrapped[" vibInferred"]["1"]]
  >;

  /**
   * Type-level comparison operand that also accepts a field reference of the
   * given scalar type.
   * @example V.FieldRefOr<"int", V.Integer>
   */
  export type FieldRefOr<
    TType extends ScalarType,
    TSchema extends VibSchema<any, any>,
  > = FieldRefOrSchema<TType, TSchema>;

  /**
   * Type-level re-closing wrapper: same shape as the wrapped schema, but a
   * field reference anywhere inside the parsed value is rejected.
   */
  export type NoFieldRef<TSchema extends VibSchema<any, any>> =
    NoFieldRefSchema<TSchema>;

  /**
   * Type-level JSON filter operand that also accepts the named JSON null
   * sentinels (`DbNull` / `JsonNull` / `AnyNull`).
   * @example V.JsonNullOr<"DbNull" | "JsonNull" | "AnyNull", V.Json>
   */
  export type JsonNullOr<
    TAllowed extends JsonNullKind,
    TSchema extends VibSchema<any, any>,
  > = JsonNullOrSchema<TAllowed, TSchema>;

  /**
   * Type-level JSON write slot: the sentinels in `TAllowed`, the whole JSON
   * document language, and no bare top-level `null` (Prisma's rule).
   */
  export type JsonWrite<
    TAllowed extends JsonNullKind,
    TSchema extends VibSchema<any, any>,
  > = JsonWriteSchema<TAllowed, TSchema>;

  export type SingleOrArray<TWrapped extends VibSchema<any, any>> = V.Union<
    readonly [
      V.Coerce<TWrapped, [TWrapped[" vibInferred"]["1"]]>,
      V.Array<TWrapped>,
    ]
  >;

  // =========================================================================
  // Utility Types
  // =========================================================================

  /**
   * Extract input type from a V.* type or VibSchema.
   */
  export type Input<T> = InferInput<T>;

  /**
   * Extract output type from a V.* type or VibSchema.
   */
  export type Output<T> = InferOutput<T>;

  /**
   * Any VibSchema - useful for generic constraints.
   */
  export type Schema<TInput = unknown, TOutput = TInput> = VibSchema<
    TInput,
    TOutput
  >;
}
