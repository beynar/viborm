// =============================================================================
// V Namespace - Type-Level Schema Mirrors
// =============================================================================
//
// This namespace provides type-level equivalents of v.* runtime functions.
// Use these for explicit type annotations in .d.ts files to avoid type expansion.
//
// Example:
//   // Instead of letting tsc expand v.object({...}) to 100+ lines:
//   type MySchema = V.Object<{ name: V.String; age: V.Number<{ optional: true }> }>;
//
// =============================================================================

import type { ArraySchema } from "./schemas/array";
import type { BigIntSchema } from "./schemas/bigint";
import type { BlobSchema } from "./schemas/blob";
import type { BooleanSchema } from "./schemas/boolean";
import type { DateSchema } from "./schemas/date";
import type { EnumSchema } from "./schemas/enum";
import type {
  IsoDateSchema,
  IsoTimeSchema,
  IsoTimestampSchema,
} from "./schemas/iso";
import type { JsonSchema, JsonValue } from "./schemas/json";
import type { LiteralSchema, LiteralValue } from "./schemas/literal";
import type { NullableSchema } from "./schemas/nullable";
import type { IntegerSchema, NumberSchema } from "./schemas/number";
import type { ObjectOptions, ObjectSchema } from "./schemas/object";
import type { OptionalSchema, WrappableSchema } from "./schemas/optional";
import type { PipeAction, PipeSchema } from "./schemas/pipe";
import type { PointSchema } from "./schemas/point";
import type { RecordSchema } from "./schemas/record";
import type { StringSchema } from "./schemas/string";
import type { TransformSchema } from "./schemas/transform";
import type { UnionSchema } from "./schemas/union";
import type { VectorSchema } from "./schemas/vector";
import type {
  ComputeInput,
  ComputeOutput,
  InferInput,
  InferOutput,
  ScalarOptions,
  VibSchema,
} from "./types";

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
  export type Record<
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
