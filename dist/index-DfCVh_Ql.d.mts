import { StandardSchemaV1 } from "@standard-schema/spec";

//#region src/validation/inferred.d.ts

/**
 * Branded key for type inference.
 *
 * KEY INSIGHT: ArkType uses a STRING, not a unique symbol.
 * This is: export declare const inferred: " arkInferred";
 *
 * Using a string literal allows TypeScript's pattern matching
 * to work correctly during circular reference resolution.
 */
declare const inferred: " vibInferred";
type inferred = typeof inferred;
//#endregion
//#region src/validation/json-schema/types.d.ts
/**
 * Standard JSON Schema types for VibORM.
 * Implements the StandardJSONSchemaV1 specification.
 * @see https://standardschema.dev/json-schema
 */
/**
 * Supported JSON Schema target versions.
 * - draft-07: JSON Schema Draft 7 (widely used)
 * - draft-2020-12: JSON Schema Draft 2020-12 (latest)
 * - openapi-3.0: OpenAPI 3.0 compatible (superset of draft-04)
 */
type JsonSchemaTarget = "draft-07" | "draft-2020-12" | "openapi-3.0" | ({} & string);
/**
 * Options for JSON Schema conversion methods.
 */
interface JsonSchemaOptions {
  /** Target JSON Schema version */
  readonly target: JsonSchemaTarget;
  /** Vendor-specific options */
  readonly libraryOptions?: Record<string, unknown> | undefined;
}
/**
 * JSON Schema object type.
 * A flexible record that can hold any JSON Schema properties.
 */
interface JsonSchema$1 {
  $schema?: string;
  $defs?: Record<string, JsonSchema$1>;
  $ref?: string;
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  properties?: Record<string, JsonSchema$1>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema$1;
  items?: JsonSchema$1 | JsonSchema$1[];
  prefixItems?: JsonSchema$1[];
  minItems?: number;
  maxItems?: number;
  anyOf?: JsonSchema$1[];
  oneOf?: JsonSchema$1[];
  allOf?: JsonSchema$1[];
  nullable?: boolean;
  format?: string;
  contentEncoding?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  default?: unknown;
  description?: string;
  title?: string;
  [key: string]: unknown;
}
/**
 * JSON Schema converter interface.
 * Provides methods to convert to input/output JSON Schema.
 */
interface JsonSchemaConverter {
  /**
   * Converts the input type to JSON Schema.
   * @throws If conversion is not supported for the given target.
   */
  readonly input: (options: JsonSchemaOptions) => Record<string, unknown>;
  /**
   * Converts the output type to JSON Schema.
   * @throws If conversion is not supported for the given target.
   */
  readonly output: (options: JsonSchemaOptions) => Record<string, unknown>;
}
//#endregion
//#region src/validation/types.d.ts
/**
 * Prettify forces TypeScript to fully evaluate the type.
 * Recursively prettifies nested objects for cleaner type display.
 * Use sparingly - mapped types are expensive!
 */
type Prettify<T> = T extends ((...args: any[]) => any) ? T : T extends object ? T extends Date ? T : { [K in keyof T]: Prettify<T[K]> } & {} : T;
/**
 * Cast interface with OPTIONAL [inferred] - for pattern matching.
 * Uses a tuple [Input, Output] to carry both types.
 */
interface Cast<TInput = unknown, TOutput = TInput> {
  [inferred]?: [TInput, TOutput];
}
/**
 * Thunk returning a Cast - for lazy type resolution in circular references.
 */
type ThunkCast<TInput = unknown, TOutput = TInput> = () => Cast<TInput, TOutput>;
/**
 * Base schema interface implementing StandardSchemaV1 and StandardJSONSchemaV1.
 * All VibORM schemas extend this interface.
 */
interface VibSchema<TInput = unknown, TOutput = TInput> extends StandardSchemaV1<TInput, TOutput> {
  /**
   * Branded type carrier for pattern matching.
   * The tuple [Input, Output] allows extracting both types.
   */
  [inferred]: [TInput, TOutput];
  /**
   * Schema type identifier for runtime checks.
   */
  readonly type: string;
  /**
   * Standard properties extended with JSON Schema converter.
   */
  readonly "~standard": StandardSchemaV1<TInput, TOutput>["~standard"] & {
    /**
     * JSON Schema converter methods.
     * Implements StandardJSONSchemaV1 specification.
     */
    readonly jsonSchema: JsonSchemaConverter;
  };
}
/**
 * Options for scalar schemas (string, number, boolean, etc.)
 * TSchemaOut allows the `schema` property to influence output type.
 */
interface ScalarOptions<T, TOut = T, TSchemaOut = TOut> {
  optional?: boolean;
  nullable?: boolean;
  array?: boolean;
  default?: any | (() => any) | undefined;
  /** Transform function applied AFTER schema validation */
  transform?: ((value: TSchemaOut) => TOut) | undefined;
  /** Additional StandardSchema for extra validation. Its output flows to transform. */
  schema?: StandardSchemaV1<T, TSchemaOut> | undefined;
}
/**
 * Extract output type from branded [inferred] property.
 * Uses constrained infer for fewer type branches.
 */
type InferOutput<Def> = Def extends {
  [inferred]?: [any, infer O];
} ? O : Def extends (() => {
  [inferred]?: [any, infer O];
}) ? O : unknown;
/**
 * Extract input type from branded [inferred] property.
 */
type InferInput<Def> = Def extends {
  [inferred]?: [infer I, any];
} ? I : Def extends (() => {
  [inferred]?: [infer I, any];
}) ? I : unknown;
/**
 * Infer output shape from object field definitions.
 * Prettify applied once at the end, not per-field.
 */
type InferOutputShape<Defs> = { [K in keyof Defs]: InferOutput<Defs[K]> };
/**
 * Infer input shape from object field definitions.
 */
type InferInputShape<Defs> = { [K in keyof Defs]: InferInput<Defs[K]> };
/**
 * Boolean key helper for option lookup.
 */
type BoolKey<T, K$1 extends keyof T> = T[K$1] extends true ? "t" : "f";
/**
 * Extract the effective input type considering schema.
 * If a schema is provided, use its input type; otherwise use base type.
 */
type EffectiveInput<T, Opts extends ScalarOptions<any, any, any>> = Opts["schema"] extends StandardSchemaV1<infer I, any> ? I : T;
/**
 * Compute input type using lookup pattern (fewer conditionals).
 */
type ComputeInput<T, Opts extends ScalarOptions<any, any, any> | undefined> = Opts extends ScalarOptions<any, any, any> ? ComputeInputLookup<EffectiveInput<T, Opts>, Opts>[`${BoolKey<Opts, "array">}${BoolKey<Opts, "nullable">}${BoolKey<Opts, "optional">}`] : T;
interface ComputeInputLookup<T, Opts extends ScalarOptions<any, any, any>> {
  ttt: T[] | null | undefined;
  ttf: Opts["default"] extends T | (() => T) ? T[] | null | undefined : T[] | null;
  tft: T[] | undefined;
  tff: Opts["default"] extends T | (() => T) ? T[] | undefined : T[];
  ftt: T | null | undefined;
  ftf: Opts["default"] extends T | (() => T) ? T | null | undefined : T | null;
  fft: T | undefined;
  fff: Opts["default"] extends T | (() => T) ? T | undefined : T;
}
/**
 * Extract the effective output type considering schema and transform.
 * Priority: transform > schema > base type
 */
type EffectiveOutput<T, Opts extends ScalarOptions<any, any, any>> = Opts["transform"] extends ((v: any) => infer R) ? R : Opts["schema"] extends StandardSchemaV1<any, infer S> ? S : T;
/**
 * Compute output type using lookup pattern.
 */
type ComputeOutput<T, Opts extends ScalarOptions<any, any, any> | undefined> = Opts extends ScalarOptions<any, any, any> ? ComputeOutputLookup<EffectiveOutput<T, Opts>, Opts>[`${BoolKey<Opts, "array">}${BoolKey<Opts, "nullable">}`] : T;
interface ComputeOutputLookup<T, _Opts> {
  tt: T[] | null;
  tf: T[];
  ft: T | null;
  ff: T;
}
interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}
interface ValidationSuccess<T> {
  readonly value: T;
  readonly issues?: undefined;
}
interface ValidationFailure {
  readonly issues: readonly ValidationIssue[];
}
type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;
declare function isVibSchema(value: unknown): value is VibSchema;
//#endregion
//#region src/validation/helpers.d.ts
/**
 * Create a failure result with a single issue.
 */
declare function fail(message: string, path?: PropertyKey[]): ValidationResult<never>;
/**
 * Create a success result.
 */
declare function ok<T>(value: T): ValidationResult<T>;
type ValidatorFn<T> = (value: unknown) => ValidationResult<T>;
/**
 * Build an optimized validator at schema creation time.
 * Uses set theory approach for nullable/optional/array/default combinations.
 *
 * @param baseValidate - The base type validator
 * @param options - Schema options
 * @param typeName - Type name for error messages (unused but kept for API consistency)
 */
declare function buildValidator<T, TOut, TSchemaOut = T>(baseValidate: ValidatorFn<T>, options: ScalarOptions<T, TOut, TSchemaOut> | undefined, _typeName: string): ValidatorFn<TOut>;
/**
 * Get default value from options.
 */
declare function getDefault<T>(options: ScalarOptions<T, any> | undefined): T | undefined;
/**
 * Create a StandardSchema-compatible schema object.
 */
declare function createSchema<TInput, TOutput>(type: string, validate: (value: unknown) => ValidationResult<TOutput>): VibSchema<TInput, TOutput>;
/**
 * Validate a value against a StandardSchema.
 */
declare function validateSchema<T>(schema: StandardSchemaV1<unknown, T>, value: unknown): ValidationResult<T>;
//#endregion
//#region src/validation/json-schema/converters.d.ts
/**
 * Converts a VibORM schema to a complete JSON Schema document.
 *
 * @param schema - The VibORM schema to convert
 * @param target - The target JSON Schema version
 * @returns Complete JSON Schema with $schema and $defs if needed
 */
declare function toJsonSchema(schema: VibSchema<unknown, unknown>, target?: JsonSchemaTarget): JsonSchema$1;
//#endregion
//#region src/validation/json-schema/factory.d.ts
/**
 * Creates a JSON Schema converter for a VibORM schema.
 * The converter provides `input` and `output` methods that generate
 * JSON Schema representations of the schema's input and output types.
 *
 * @param schema - The VibORM schema to create a converter for
 * @returns A JsonSchemaConverter with input and output methods
 */
declare function createJsonSchemaConverter(schema: VibSchema<unknown, unknown>): JsonSchemaConverter;
//#endregion
//#region src/validation/schemas/array.d.ts
interface ArraySchema<TItem extends VibSchema<any, any>, TInput = InferInput<TItem>[], TOutput = InferOutput<TItem>[]> extends VibSchema<TInput, TOutput> {
  readonly type: "array";
  readonly item: TItem;
}
/**
 * Create an array schema that validates each item.
 *
 * @example
 * const tags = v.array(v.string());
 * const scores = v.array(v.number());
 */
declare function array<TItem extends VibSchema<any, any>>(item: TItem): ArraySchema<TItem>;
//#endregion
//#region src/validation/schemas/bigint.d.ts
interface BaseBigIntSchema<Opts extends ScalarOptions<bigint, any> | undefined = undefined> extends VibSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>> {}
interface BigIntSchema<TInput = bigint, TOutput = bigint> extends VibSchema<TInput, TOutput> {
  readonly type: "bigint";
}
/**
 * Validate that a value is a bigint.
 */
declare function validateBigInt(value: unknown): ValidationResult<bigint> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected bigint";
  }>[];
}>;
/**
 * Create a bigint schema.
 *
 * @example
 * const id = v.bigint();
 * const optionalId = v.bigint({ optional: true });
 */
declare function bigint<const Opts extends ScalarOptions<bigint, any> | undefined = undefined>(options?: Opts): BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;
//#endregion
//#region src/validation/schemas/blob.d.ts
interface BaseBlobSchema<Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined> extends VibSchema<ComputeInput<Uint8Array, Opts>, ComputeOutput<Uint8Array, Opts>> {}
interface BlobSchema<TInput = Uint8Array, TOutput = Uint8Array> extends VibSchema<TInput, TOutput> {
  readonly type: "blob";
}
/**
 * Validate that a value is a Uint8Array or Buffer.
 */
declare function validateBlob(value: unknown): ValidationResult<Uint8Array<ArrayBufferLike>> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected Uint8Array or Buffer";
  }>[];
}>;
/**
 * Create a blob schema for binary data (Uint8Array/Buffer).
 *
 * @example
 * const avatar = v.blob();
 * const optionalBlob = v.blob({ optional: true });
 * const nullableBlob = v.blob({ nullable: true });
 */
declare function blob<const Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined>(options?: Opts): BlobSchema<ComputeInput<Uint8Array, Opts>, ComputeOutput<Uint8Array, Opts>>;
//#endregion
//#region src/validation/schemas/boolean.d.ts
interface BaseBooleanSchema<Opts extends ScalarOptions<boolean, any> | undefined = undefined> extends VibSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>> {}
interface BooleanSchema<TInput = boolean, TOutput = boolean> extends VibSchema<TInput, TOutput> {
  readonly type: "boolean";
}
/**
 * Validate that a value is a boolean.
 */
declare function validateBoolean(value: unknown): ValidationResult<boolean> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected boolean";
  }>[];
}>;
/**
 * Create a boolean schema.
 *
 * @example
 * const active = v.boolean();
 * const optionalFlag = v.boolean({ optional: true });
 */
declare function boolean<const Opts extends ScalarOptions<boolean, any> | undefined = undefined>(options?: Opts): BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
//#endregion
//#region src/validation/schemas/date.d.ts
interface BaseDateSchema<Opts extends ScalarOptions<Date, any> | undefined = undefined> extends VibSchema<ComputeInput<Date, Opts>, ComputeOutput<Date, Opts>> {}
interface DateSchema<TInput = Date, TOutput = Date> extends VibSchema<TInput, TOutput> {
  readonly type: "date";
}
/**
 * Validate that a value is a JavaScript Date object.
 */
declare function validateDate(value: unknown): Readonly<{
  issues: readonly Readonly<{
    message: "Expected Date";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected valid Date";
  }>[];
}> | ValidationResult<Date>;
/**
 * Create a date schema for JavaScript Date objects.
 *
 * @example
 * const createdAt = v.date();
 * const optionalDate = v.date({ optional: true });
 */
declare function date<const Opts extends ScalarOptions<Date, any> | undefined = undefined>(options?: Opts): DateSchema<ComputeInput<Date, Opts>, ComputeOutput<Date, Opts>>;
//#endregion
//#region src/validation/schemas/enum.d.ts
type BaseEnumSchema<TValues extends string[], Opts extends ScalarOptions<TValues[number], any> | undefined = undefined> = EnumSchema<TValues, ComputeInput<TValues[number], Opts>, ComputeOutput<TValues[number], Opts>>;
interface EnumSchema<TValues extends string[], TInput = TValues[number], TOutput = TValues[number]> extends VibSchema<TInput, TOutput> {
  readonly type: "enum";
  readonly values: TValues;
}
/**
 * Create an enum schema that validates a value is one of the allowed values.
 *
 * @param values - Array of allowed values (strings or numbers)
 * @param options - Schema options
 *
 * @example
 * const status = v.enum_(["active", "inactive", "pending"]);
 * const level = v.enum_([1, 2, 3]);
 * const mixed = v.enum_(["a", 1, "b", 2]);
 */
declare function enum_<const TValues extends string[], const Opts extends ScalarOptions<TValues[number], any> | undefined = undefined>(values: TValues, options?: Opts): EnumSchema<TValues, ComputeInput<TValues[number], Opts>, ComputeOutput<TValues[number], Opts>>;
//#endregion
//#region src/validation/schemas/instance.d.ts
interface InstanceSchema<TClass extends abstract new (...args: any) => any, TInput = InstanceType<TClass>, TOutput = InstanceType<TClass>> extends VibSchema<TInput, TOutput> {
  readonly type: "instance";
}
/**
 * Create an instance schema for validating class instances.
 *
 * @example
 * const buffer = v.instance(Uint8Array);
 * const blob = v.union([v.instance(Uint8Array), v.instance(Buffer)]);
 */
declare function instance<TClass extends abstract new (...args: any) => any, const Opts extends ScalarOptions<InstanceType<TClass>, any> | undefined = undefined>(classConstructor: TClass, options?: Opts): InstanceSchema<TClass, ComputeInput<InstanceType<TClass>, Opts>, ComputeOutput<InstanceType<TClass>, Opts>>;
//#endregion
//#region src/validation/schemas/iso.d.ts
interface BaseIsoTimestampSchema<Opts extends ScalarOptions<string, any> | undefined = undefined> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}
interface IsoTimestampSchema<TInput = string | Date, TOutput = string> extends VibSchema<TInput, TOutput> {
  readonly type: "iso_timestamp";
}
/**
 * Validate ISO timestamp format.
 * Accepts Date objects and converts them to ISO strings.
 */
declare function validateIsoTimestamp(value: unknown): Readonly<{
  issues: readonly Readonly<{
    message: "Invalid date in ISO timestamp";
  }>[];
}> | ValidationResult<string> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected string or Date";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected ISO timestamp format (YYYY-MM-DDTHH:mm:ss.sssZ)";
  }>[];
}>;
/**
 * Create an ISO timestamp schema.
 * Accepts strings in format: 2023-12-15T10:30:00.000Z or Date objects.
 * Date objects are automatically converted to ISO strings.
 *
 * @example
 * const timestamp = v.isoTimestamp();
 * parse(timestamp, new Date()) // Returns ISO string
 */
declare function isoTimestamp<const Opts extends ScalarOptions<string, any> | undefined = undefined>(options?: Opts): IsoTimestampSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>>;
interface BaseIsoDateSchema<Opts extends ScalarOptions<string, any> | undefined = undefined> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}
interface IsoDateSchema<TInput = string | Date, TOutput = string> extends VibSchema<TInput, TOutput> {
  readonly type: "iso_date";
}
/**
 * Validate ISO date format.
 * Accepts Date objects and converts them to ISO date strings (YYYY-MM-DD).
 */
declare function validateIsoDate(value: unknown): ValidationResult<string> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected string or Date";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Invalid date";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected ISO date format (YYYY-MM-DD)";
  }>[];
}>;
/**
 * Create an ISO date schema.
 * Accepts strings in format: 2023-12-15 or Date objects.
 * Date objects are automatically converted to ISO date strings (YYYY-MM-DD).
 *
 * @example
 * const birthDate = v.isoDate();
 * parse(birthDate, new Date()) // Returns "2023-12-15"
 */
declare function isoDate<const Opts extends ScalarOptions<string, any> | undefined = undefined>(options?: Opts): IsoDateSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>>;
interface BaseIsoTimeSchema<Opts extends ScalarOptions<string, any> | undefined = undefined> extends VibSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>> {}
interface IsoTimeSchema<TInput = string | Date, TOutput = string> extends VibSchema<TInput, TOutput> {
  readonly type: "iso_time";
}
/**
 * Validate ISO time format.
 * Accepts Date objects and extracts the time portion (HH:mm:ss.sss).
 */
declare function validateIsoTime(value: unknown): ValidationResult<string> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected string or Date";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Invalid time";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected ISO time format (HH:mm:ss)";
  }>[];
}>;
/**
 * Create an ISO time schema.
 * Accepts strings in format: 10:30:00 or Date objects.
 * Date objects are automatically converted to time strings (HH:mm:ss.sss).
 *
 * @example
 * const startTime = v.isoTime();
 * parse(startTime, new Date()) // Returns "10:30:00.000"
 */
declare function isoTime<const Opts extends ScalarOptions<string, any> | undefined = undefined>(options?: Opts): IsoTimeSchema<ComputeInput<string | Date, Opts>, ComputeOutput<string, Opts>>;
//#endregion
//#region src/validation/schemas/json.d.ts
/**
 * JSON-compatible value type.
 * Represents any value that can be safely serialized to JSON.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | {
  [key: string]: JsonValue;
};
interface BaseJsonSchema<Opts extends ScalarOptions<JsonValue, any> | undefined = undefined> extends VibSchema<ComputeInput<JsonValue, Opts>, ComputeOutput<JsonValue, Opts>> {}
interface JsonSchema<TInput = JsonValue, TOutput = JsonValue> extends VibSchema<TInput, TOutput> {
  readonly type: "json";
}
/**
 * Check if a value is JSON-compatible (can be serialized without loss).
 * Rejects: undefined, functions, symbols, bigint, circular references.
 */
declare function isJsonValue(value: unknown, seen?: WeakSet<object>): boolean;
/**
 * Validate that a value is JSON-compatible.
 */
declare function validateJson(value: unknown): ValidationResult<JsonValue> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected JSON-compatible value";
  }>[];
}>;
/**
 * Create a JSON schema that validates any JSON-compatible value.
 * Accepts: strings, numbers (finite), booleans, null, arrays, plain objects.
 * Rejects: undefined, functions, symbols, bigint, circular references, class instances.
 *
 * @example
 * const data = v.json();
 * const optionalData = v.json({ optional: true });
 * const nullableData = v.json({ nullable: true });
 */
declare function json<const Opts extends ScalarOptions<JsonValue, any> | undefined = undefined>(options?: Opts): JsonSchema<ComputeInput<JsonValue, Opts>, ComputeOutput<JsonValue, Opts>>;
//#endregion
//#region src/validation/schemas/literal.d.ts
type LiteralValue = string | number | boolean | null | undefined | bigint;
interface LiteralSchema<T extends LiteralValue, TInput = T, TOutput = T> extends VibSchema<TInput, TOutput> {
  readonly type: "literal";
  readonly value: T;
}
/**
 * Create a literal schema that matches an exact value.
 *
 * @example
 * const admin = v.literal("admin");
 * const zero = v.literal(0);
 * const isTrue = v.literal(true);
 */
declare function literal<const T extends LiteralValue, const Opts extends ScalarOptions<T, any> | undefined = undefined>(expected: T, options?: Opts): LiteralSchema<T, ComputeInput<T, Opts>, ComputeOutput<T, Opts>>;
//#endregion
//#region src/validation/schemas/nonArray.d.ts
/**
 * Extract element type from array type.
 */
type ElementOf<T> = T extends readonly (infer E)[] ? E : T;
/**
 * Schema that validates a single element instead of an array.
 * Useful for unwrapping array schemas.
 */
interface NonArraySchema<TInput, TOutput> extends VibSchema<TInput, TOutput> {
  readonly type: "nonArray";
}
/**
 * Unwrap an array schema to validate single elements.
 * If the wrapped schema expects an array, this validates a single element.
 *
 * @example
 * const tags = v.string({ array: true });
 * // tags validates: string[]
 *
 * const singleTag = v.nonArray(tags);
 * // singleTag validates: string
 *
 * @example
 * // Alias: element()
 * const oneItem = v.element(v.number({ array: true }));
 */
declare function nonArray<I$1, O$1>(schema: StandardSchemaV1<I$1[], O$1[]>): NonArraySchema<ElementOf<I$1>, ElementOf<O$1>>;
declare function nonArray<I$1, O$1>(schema: StandardSchemaV1<I$1, O$1>): NonArraySchema<ElementOf<I$1>, ElementOf<O$1>>;
/**
 * Alias for nonArray.
 * Extracts the element schema from an array schema.
 */
declare const element: typeof nonArray;
//#endregion
//#region src/validation/schemas/nonNullable.d.ts
/**
 * Schema that wraps another schema and excludes null from both input and output.
 * Rejects null values at validation time.
 */
interface NonNullableSchema<TInput, TOutput> extends VibSchema<TInput, TOutput> {
  readonly type: "nonNullable";
}
/**
 * Wrap a schema to exclude null from both input and output types.
 * Fails validation if the value is null.
 *
 * @example
 * const maybeNull = v.string({ nullable: true });
 * const definitelyString = v.nonNullable(maybeNull);
 * // Input: string, Output: string (null excluded from both)
 *
 * @example
 * // Works with any StandardSchemaV1
 * const externalSchema: StandardSchemaV1<unknown, string | null> = ...;
 * const strict = v.nonNullable(externalSchema);
 */
declare function nonNullable<I$1, O$1>(schema: StandardSchemaV1<I$1, O$1 | null> | StandardSchemaV1<I$1, O$1>): NonNullableSchema<NonNullable<I$1>, NonNullable<O$1>>;
//#endregion
//#region src/validation/schemas/nonOptional.d.ts
/**
 * Schema that wraps another schema and ensures the value is defined.
 * Rejects undefined values.
 */
interface NonOptionalSchema<TInput, TOutput> extends VibSchema<TInput, TOutput> {
  readonly type: "nonOptional";
}
/**
 * Wrap a schema to ensure its input/output is not undefined.
 * Fails validation if the value is undefined.
 *
 * @example
 * const maybeUndefined = v.string({ optional: true });
 * const required = v.nonOptional(maybeUndefined);
 * // Input: string, Output: string (undefined rejected)
 *
 * @example
 * // Alias: required()
 * const requiredName = v.required(v.string({ optional: true }));
 */
declare function nonOptional<I$1, O$1>(schema: StandardSchemaV1<I$1 | undefined, O$1 | undefined> | StandardSchemaV1<I$1, O$1 | undefined> | StandardSchemaV1<I$1 | undefined, O$1> | StandardSchemaV1<I$1, O$1>): NonOptionalSchema<Exclude<I$1, undefined>, Exclude<O$1, undefined>>;
/**
 * Alias for nonOptional.
 * Makes a schema required (rejects undefined).
 */
declare const required: typeof nonOptional;
//#endregion
//#region src/validation/schemas/nullable.d.ts
interface NullableSchema<TWrapped extends VibSchema<any, any>, TInput = InferInput<TWrapped> | null, TOutput = InferOutput<TWrapped> | null> extends VibSchema<TInput, TOutput> {
  readonly type: "nullable";
  readonly wrapped: TWrapped;
}
/**
 * Create a nullable schema that allows null values.
 *
 * @example
 * const nullableName = v.nullable(v.string());
 */
declare function nullable<TWrapped extends VibSchema<any, any>>(wrapped: TWrapped): NullableSchema<TWrapped>;
/**
 * Conditionally wrap a schema in nullable based on a boolean flag.
 * Useful for building schemas dynamically where nullability is determined at compile time.
 *
 * @example
 * const schema = v.maybeNullable(v.string(), true);  // NullableSchema<StringSchema>
 * const schema2 = v.maybeNullable(v.string(), false); // StringSchema
 */
declare function maybeNullable<TWrapped extends VibSchema<any, any>, TIsNullable extends boolean>(wrapped: TWrapped, isNullable: TIsNullable): TIsNullable extends true ? NullableSchema<TWrapped> : TWrapped;
//#endregion
//#region src/validation/schemas/number.d.ts
interface BaseNumberSchema<Opts extends ScalarOptions<number, any> | undefined = undefined> extends VibSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {}
interface NumberSchema<TInput = number, TOutput = number> extends VibSchema<TInput, TOutput> {
  readonly type: "number";
}
/**
 * Validate that a value is a finite number (rejects NaN and Infinity).
 */
declare function validateNumber(value: unknown): ValidationResult<number> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected finite number";
  }>[];
}>;
/**
 * Create a number schema.
 *
 * @example
 * const age = v.number();
 * const optionalAge = v.number({ optional: true });
 * const scores = v.number({ array: true });
 */
declare function number<const Opts extends ScalarOptions<number, any> | undefined = undefined>(options?: Opts): NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
interface BaseIntegerSchema<Opts extends ScalarOptions<number, any> | undefined = undefined> extends VibSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>> {}
interface IntegerSchema<TInput = number, TOutput = number> extends VibSchema<TInput, TOutput> {
  readonly type: "integer";
}
/**
 * Validate that a value is an integer.
 */
declare function validateInteger(value: unknown): ValidationResult<number> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected integer";
  }>[];
}>;
/**
 * Create an integer schema.
 *
 * @example
 * const count = v.integer();
 */
declare function integer<const Opts extends ScalarOptions<number, any> | undefined = undefined>(options?: Opts): IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
//#endregion
//#region src/validation/schemas/object.d.ts
/**
 * Object entries - a record of field names to schemas or thunks.
 */
type ObjectEntries = Record<string, VibSchema<any, any> | ThunkCast<any, any>>;
/**
 * Options for object schemas.
 */
interface ObjectOptions<T = unknown, TKeys extends string = string> {
  /** Make all fields optional (default: true) */
  partial?: boolean;
  /** Reject unknown keys (default: true) */
  strict?: boolean;
  /** Make the object itself optional (undefined allowed) */
  optional?: boolean;
  /** Make the object itself nullable (null allowed) */
  nullable?: boolean;
  /** Validate as array of objects */
  array?: boolean;
  /** Default value when undefined/null */
  default?: T | (() => T);
  /** Transform output */
  transform?: (value: T) => T;
  /** Object name for circular references in json schema*/
  name?: string;
  /** Object description for json schema*/
  description?: string;
  /** Require at least these specific keys (works with partial: true) */
  atLeast?: TKeys[];
}
/**
 * Compute input type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 * If atLeast is specified, those keys are required even when partial: true
 */
type ComputeObjectInput<TEntries, TOpts> = TOpts extends {
  partial: false;
} ? InferInputShape<TEntries> : TOpts extends {
  atLeast: infer Keys extends readonly string[];
} ? RequireKeys<Partial<InferInputShape<TEntries>>, Keys[number]> : Partial<InferInputShape<TEntries>>;
/**
 * Compute output type based on partial option.
 * Default is partial: true, so only non-partial when explicitly { partial: false }
 * If atLeast is specified, those keys are required even when partial: true
 */
type ComputeObjectOutput<TEntries, TOpts> = TOpts extends {
  partial: false;
} ? InferOutputShape<TEntries> : TOpts extends {
  atLeast: infer Keys extends readonly string[];
} ? RequireKeys<Partial<InferOutputShape<TEntries>>, Keys[number]> : Partial<InferOutputShape<TEntries>>;
/**
 * Make specific keys required in an otherwise partial object.
 * Uses a mapped type instead of Omit & Required<Pick> to reduce type depth.
 */
type RequireKeys<T, K$1 extends string> = { [P in keyof T as P extends K$1 ? never : P]?: T[P] } & { [P in keyof T as P extends K$1 ? P : never]-?: T[P] };
/**
 * Apply wrapper options (optional, nullable, array) to object type.
 */
type ApplyObjectOptions<TBase, TOpts> = TOpts extends {
  array: true;
} ? TOpts extends {
  optional: true;
} ? TOpts extends {
  nullable: true;
} ? TBase[] | undefined | null : TBase[] | undefined : TOpts extends {
  nullable: true;
} ? TBase[] | null : TBase[] : TOpts extends {
  optional: true;
} ? TOpts extends {
  nullable: true;
} ? TBase | undefined | null : TBase | undefined : TOpts extends {
  nullable: true;
} ? TBase | null : TBase;
/**
 * Object schema interface.
 */
interface ObjectSchema<TEntries, TOpts extends ObjectOptions | undefined = undefined, TInput = ApplyObjectOptions<ComputeObjectInput<TEntries, TOpts>, TOpts>, TOutput = ApplyObjectOptions<ComputeObjectOutput<TEntries, TOpts>, TOpts>> extends VibSchema<TInput, TOutput> {
  readonly type: "object";
  readonly entries: TEntries;
  readonly options: TOpts;
  readonly parse: VibSchema<TInput, TOutput>["~standard"]["validate"];
  /** Extend this schema with additional entries */
  extend<TNewEntries extends ObjectEntries, TNewTOpts extends ObjectOptions | undefined = undefined>(newEntries: TNewEntries, options?: TNewTOpts): ObjectSchema<TEntries & TNewEntries, TOpts & TNewTOpts>;
}
/**
 * Create an object schema.
 *
 * IMPORTANT: No constraint on TEntries to allow circular reference resolution.
 * The identity conditional (R extends infer _ ? _ : never) defers type evaluation.
 *
 * @param entries - Object field definitions
 * @param options - Schema options
 *   - `strict` (default: true) - Reject unknown keys
 *   - `partial` (default: true) - Make all fields optional
 *   - `optional` - Allow undefined
 *   - `nullable` - Allow null
 *   - `array` - Validate as array of objects
 *   - `default` - Default value
 *   - `transform` - Transform output
 *
 * @example
 * // Basic object (strict by default)
 * const user = v.object({
 *   name: v.string(),
 *   age: v.number(),
 * });
 *
 * // Circular references
 * const node = v.object({
 *   value: v.string(),
 *   child: () => node,  // Thunk
 * });
 */
declare function object<TEntries,
// NO constraint - critical for circular references
const TOpts extends ObjectOptions | undefined = undefined, R = ObjectSchema<TEntries, TOpts>>(entries: TEntries, options?: TOpts): R extends infer _ ? _ : never;
//#endregion
//#region src/validation/schemas/optional.d.ts
/**
 * Schema or thunk that can be wrapped with optional.
 */
type WrappableSchema = VibSchema<any, any> | ThunkCast<any, any> | (() => Cast<any, any>);
/**
 * Unwrap a schema or thunk to get the underlying schema type.
 */
type UnwrapSchema<T> = T extends VibSchema<any, any> ? T : T extends ThunkCast<infer I, infer O> ? VibSchema<I, O> : T extends (() => Cast<infer I, infer O>) ? VibSchema<I, O> : never;
interface OptionalSchema<TWrapped extends WrappableSchema, TDefault = undefined, TInput = InferInput<UnwrapSchema<TWrapped>> | undefined, TOutput = (TDefault extends undefined ? InferOutput<UnwrapSchema<TWrapped>> | undefined : InferOutput<UnwrapSchema<TWrapped>>)> extends VibSchema<TInput, TOutput> {
  readonly type: "optional";
  readonly wrapped: TWrapped;
  readonly default: TDefault;
}
/**
 * Create an optional schema that allows undefined values.
 * Supports both direct schemas and thunks (for circular references).
 * Optionally provide a default value for when undefined is received.
 *
 * @example
 * const optionalName = v.optional(v.string());
 * const nameWithDefault = v.optional(v.string(), "Unknown");
 *
 * // With thunks (circular references)
 * const node = v.object({ child: v.optional(() => node) });
 */
declare function optional<TWrapped extends WrappableSchema, TDefault extends InferOutput<UnwrapSchema<TWrapped>> | (() => InferOutput<UnwrapSchema<TWrapped>>) | undefined = undefined>(wrapped: TWrapped, defaultValue?: TDefault): OptionalSchema<TWrapped, TDefault>;
//#endregion
//#region src/validation/schemas/point.d.ts
/**
 * Point type with x and y coordinates.
 */
interface Point {
  x: number;
  y: number;
}
interface BasePointSchema<Opts extends ScalarOptions<Point, any> | undefined = undefined> extends VibSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>> {}
interface PointSchema<TInput = Point, TOutput = Point> extends VibSchema<TInput, TOutput> {
  readonly type: "point";
}
/**
 * Validate that a value is a point with x and y coordinates.
 */
declare function validatePoint(value: unknown): Readonly<{
  issues: readonly Readonly<{
    message: "Expected point object";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected point with x and y properties";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected x to be a number";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected y to be a number";
  }>[];
}> | ValidationResult<Point>;
/**
 * Create a point schema for { x, y } coordinates.
 *
 * @example
 * const location = v.point();
 * const optionalPoint = v.point({ optional: true });
 * const pointArray = v.point({ array: true });
 */
declare function point<const Opts extends ScalarOptions<Point, any> | undefined = undefined>(options?: Opts): PointSchema<ComputeInput<Point, Opts>, ComputeOutput<Point, Opts>>;
//#endregion
//#region src/validation/schemas/string.d.ts
interface BaseStringSchema<Opts extends ScalarOptions<string, any> | undefined = undefined> extends VibSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>> {}
interface StringSchema<TInput = string, TOutput = string> extends VibSchema<TInput, TOutput> {
  readonly type: "string";
}
/**
 * Validate that a value is a string.
 */
declare function validateString(value: unknown): ValidationResult<string> | Readonly<{
  issues: readonly Readonly<{
    message: "Expected string";
  }>[];
}>;
/**
 * Create a string schema.
 *
 * @example
 * const name = v.string();
 * const optionalName = v.string({ optional: true });
 * const tags = v.string({ array: true });
 */
declare function string<const Opts extends ScalarOptions<string, any> | undefined = undefined>(options?: Opts): StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
//#endregion
//#region src/validation/schemas/union.d.ts
interface UnionSchema<TOptions extends readonly VibSchema<any, any>[], TInput = TOptions[number][" vibInferred"]["0"], TOutput = InferOutput<TOptions[number]>> extends VibSchema<TInput, TOutput> {
  readonly type: "union";
  readonly options: TOptions;
}
/**
 * Create a union schema that validates against multiple options.
 * Returns the result of the first matching schema.
 *
 * @example
 * const stringOrNumber = v.union([v.string(), v.number()]);
 */
declare function union<const TOptions extends readonly VibSchema<any, any>[]>(options: TOptions): UnionSchema<TOptions>;
//#endregion
//#region src/validation/schemas/vector.d.ts
interface BaseVectorSchema<Opts extends ScalarOptions<number[], any> | undefined = undefined> extends VibSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>> {}
interface VectorSchema<TInput = number[], TOutput = number[]> extends VibSchema<TInput, TOutput> {
  readonly type: "vector";
}
/**
 * Validate that a value is a vector (array of numbers).
 * Optionally check for specific dimensions.
 */
declare function createVectorValidator(dimensions?: number): (value: unknown) => ValidationFailure | Readonly<{
  issues: readonly Readonly<{
    message: "Expected array of numbers";
  }>[];
}> | Readonly<{
  issues: readonly Readonly<{
    message: `Expected vector of ${number} dimensions`;
  }>[];
}> | ValidationSuccess<number[]>;
/**
 * Create a vector schema for arrays of numbers (embeddings, coordinates, etc.)
 *
 * @param dimensions - Optional fixed number of dimensions
 * @param options - Schema options
 *
 * @example
 * const embedding = v.vector();                    // Any length
 * const embedding3d = v.vector(3);                 // Exactly 3 dimensions
 * const optionalVector = v.vector(undefined, { optional: true });
 */
declare function vector<const Opts extends ScalarOptions<number[], any> | undefined = undefined>(dimensions?: number, options?: Opts): VectorSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>> & {
  dimensions?: number;
};
//#endregion
//#region src/validation/schemas/from-object.d.ts
/**
 * Gets the value at a dot path in an object type.
 * Supports nested paths like "create.name" or "create.friends".
 */
type PathValue<T, P$1 extends string> = P$1 extends `${infer Key}.${infer Rest}` ? Key extends keyof T ? T[Key] extends Record<string, any> ? PathValue<T[Key], Rest> : never : never : P$1 extends keyof T ? T[P$1] : never;
/**
 * Recursively extracts all dot paths that lead to VibSchema or ThunkCast instances.
 * Returns a union of all valid paths (e.g., "create" | "create.name").
 * Limited to 5 levels of nesting to avoid infinite recursion.
 */
type PathsToSchemas<T extends string, Prefix extends string = "", Depth extends readonly unknown[] = []> = Depth["length"] extends 5 ? never : T extends VibSchema<any, any> ? Prefix : T extends ThunkCast<any, any> ? Prefix : T extends (() => Cast<any, any>) ? Prefix : T extends Record<string, any> ? { [K in keyof T]: K extends string ? PathsToSchemas<T[K], Prefix extends "" ? K : `${Prefix}.${K}`, [...Depth, unknown]> : never }[keyof T] : never;
/**
 * Normalize a schema entry to VibSchema.
 * Handles both direct VibSchema and ThunkCast (unwrapping the thunk's return type).
 */
type NormalizeSchemaEntry<T> = T extends VibSchema<infer I, infer O> ? VibSchema<I, O> : T extends ThunkCast<infer I, infer O> ? VibSchema<I, O> : T extends (() => Cast<infer I, infer O>) ? VibSchema<I, O> : never;
/**
 * Gets the schema type at a specific path for a specific key.
 * Handles both VibSchema and ThunkCast entries.
 */
type SchemaAtPath<TObject extends Record<string, any>, TPath extends string, K$1 extends keyof TObject> = NormalizeSchemaEntry<PathValue<TObject[K$1], TPath>>;
/**
 * Extracts all valid paths that lead to schemas from all keys in the object.
 */
type AllPathsToSchemas<TObject extends Record<string, any>> = { [K in keyof TObject]: K extends string ? PathsToSchemas<TObject[K]> : never }[keyof TObject];
/**
 * Options for fromObject schemas (same as ObjectOptions).
 */
type FromObjectOptions<T = unknown> = ObjectOptions<T>;
/**
 * Compute the entries type from an object and path.
 */
type ComputeEntries<TObject extends Record<string, any>, TPath extends string> = { [K in keyof TObject]: SchemaAtPath<TObject, TPath, K> };
/**
 * FromObject schema type (alias for ObjectSchema with computed entries).
 */
type FromObjectSchema<TEntries, TOpts extends FromObjectOptions | undefined = undefined, TInput = unknown, TOutput = unknown> = ObjectSchema<TEntries, TOpts>;
/**
 * Creates an object schema by extracting schemas from a record using a dot path.
 * This is a convenient way to build an object schema from a record with proper type inference.
 *
 * @param sourceObject - Source object containing nested schemas
 * @param path - Dot path to extract schemas (e.g., "create", "filter.where")
 * @param options - Schema options (same as object schema)
 *
 * @example
 * // Given a record of models with nested schemas:
 * const models = {
 *   user: { create: v.string(), update: v.string() },
 *   post: { create: v.number(), update: v.number() },
 * };
 *
 * // Extract all "create" schemas into a single object schema:
 * const createSchema = fromObject(models, "create");
 * // Validates: { user: string, post: number }
 *
 * // With options:
 * const optionalSchema = fromObject(models, "create", { optional: true });
 * // Validates: { user: string, post: number } | undefined
 *
 * @example
 * // Nested paths work too:
 * const nestedModels = {
 *   user: { schemas: { create: v.string() } },
 *   post: { schemas: { create: v.number() } },
 * };
 * const nestedSchema = fromObject(nestedModels, "schemas.create");
 * // Validates: { user: string, post: number }
 */
declare function fromObject<TObject extends Record<string, any>, TPath extends string, const TOpts extends FromObjectOptions | undefined = undefined>(sourceObject: TObject, path: TPath, options?: TOpts): ObjectSchema<ComputeEntries<TObject, TPath>, TOpts>;
//#endregion
//#region src/validation/schemas/pipe.d.ts
/**
 * Transform action interface.
 */
interface TransformAction<TIn, TOut> {
  readonly type: "transform";
  readonly transform: (value: TIn) => TOut;
}
/**
 * Create a transform action for use with pipe.
 *
 * @example
 * const upperCase = v.pipe(v.string(), v.transform(s => s.toUpperCase()));
 */
declare function transform<TIn, TOut>(fn: (value: TIn) => TOut): TransformAction<TIn, TOut>;
/**
 * Pipe action types.
 */
type PipeAction<TIn, TOut> = TransformAction<TIn, TOut>;
/**
 * Pipe schema interface.
 */
interface PipeSchema<TSchema extends VibSchema<any, any>, TActions extends readonly PipeAction<any, any>[], TInput = InferInput<TSchema>, TOutput = (TActions extends readonly [...any[], PipeAction<any, infer TLast>] ? TLast : InferOutput<TSchema>)> extends VibSchema<TInput, TOutput> {
  readonly type: "pipe";
  readonly schema: TSchema;
  readonly actions: TActions;
}
/**
 * Infer the final output type from a chain of actions.
 */
type InferPipeOutput<TSchema extends VibSchema<any, any>, TActions extends readonly PipeAction<any, any>[]> = TActions extends readonly [] ? InferOutput<TSchema> : TActions extends readonly [PipeAction<any, infer TOut>] ? TOut : TActions extends readonly [PipeAction<any, infer TMid>, ...infer TRest] ? TRest extends readonly PipeAction<any, any>[] ? InferPipeOutput<VibSchema<TMid, TMid>, TRest> : TMid : InferOutput<TSchema>;
/**
 * Create a pipe schema that chains a base schema with transform actions.
 *
 * @example
 * const trimmedString = v.pipe(v.string(), v.transform(s => s.trim()));
 * const isoDate = v.pipe(v.date(), v.transform(d => d.toISOString()));
 */
declare function pipe<TSchema extends VibSchema<any, any>, const TActions extends readonly PipeAction<any, any>[]>(schema: TSchema, ...actions: TActions): PipeSchema<TSchema, TActions, InferInput<TSchema>, InferPipeOutput<TSchema, TActions>>;
//#endregion
//#region src/validation/schemas/record.d.ts
interface RecordSchema<TKey extends VibSchema<string, string>, TValue extends VibSchema<any, any>, TInput = Record<InferInput<TKey>, InferInput<TValue>>, TOutput = Record<InferOutput<TKey>, InferOutput<TValue>>> extends VibSchema<TInput, TOutput> {
  readonly type: "record";
  readonly key: TKey;
  readonly value: TValue;
}
/**
 * Create a record schema that validates keys and values.
 *
 * @example
 * const stringRecord = v.record(v.string(), v.number());
 * // Validates: { foo: 1, bar: 2 }
 */
declare function record<TKey extends VibSchema<string, string>, TValue extends VibSchema<any, any>>(key: TKey, value: TValue): RecordSchema<TKey, TValue>;
/**
 * Schema entry type - VibSchema or ThunkCast for circular references.
 */
type SchemaEntry = VibSchema<any, any> | ThunkCast<any, any> | (() => Cast<any, any>);
/**
 * Normalize a schema entry to VibSchema for type extraction.
 */
type NormalizeEntry<T> = T extends VibSchema<infer I, infer O> ? VibSchema<I, O> : T extends ThunkCast<infer I, infer O> ? VibSchema<I, O> : T extends (() => Cast<infer I, infer O>) ? VibSchema<I, O> : never;
/**
 * Compute entries from a tuple of keys and a schema.
 */
type ComputeEntriesFromKeys<TKeys extends readonly string[], TSchema extends SchemaEntry> = { [K in TKeys[number]]: NormalizeEntry<TSchema> };
/**
 * Options for fromKeys (same as ObjectOptions).
 */
type FromKeysOptions<T = unknown> = ObjectOptions<T>;
/**
 * Creates an object schema from an array of keys, all mapping to the same schema.
 * This is a convenient wrapper around `object()` for creating uniform schemas.
 *
 * @param keys - Array of key names (use `as const` for type inference)
 * @param schema - Schema to use for all keys (can be a thunk for circular refs)
 * @param options - Schema options (same as object schema)
 *
 * @example
 * // All keys have the same string schema
 * const schema = v.fromKeys(["name", "email", "bio"] as const, v.string());
 * // → ObjectSchema<{ name: string, email: string, bio: string }>
 *
 * @example
 * // With options
 * const optionalSchema = v.fromKeys(
 *   ["user", "post"] as const,
 *   v.number(),
 *   { partial: false }
 * );
 * // → ObjectSchema<{ user: number, post: number }> (all required)
 *
 * @example
 * // With thunks for circular references
 * const nodeSchema: VibSchema<any, any> = v.object({ value: v.string() });
 * const schema = v.fromKeys(
 *   ["left", "right"] as const,
 *   () => nodeSchema,
 *   { optional: true }
 * );
 */
declare function fromKeys<const TKeys extends readonly string[], TSchema extends SchemaEntry, const TOpts extends FromKeysOptions | undefined = undefined>(keys: TKeys, schema: TSchema, options?: TOpts): ObjectSchema<ComputeEntriesFromKeys<TKeys, TSchema>, TOpts>;
//#endregion
//#region src/validation/schemas/transform.d.ts
/**
 * Schema that wraps another schema and transforms its output.
 */
interface TransformSchema<TInput, TOutput> extends VibSchema<TInput, TOutput> {
  readonly type: "transform";
}
/**
 * Wrap a schema with a transform function.
 * Validates with the wrapped schema, then applies the transform to the output.
 *
 * @param schema - The base schema to validate with
 * @param fn - Transform function: (validatedValue) => newValue
 *
 * @example
 * // String to uppercase
 * const upper = v.coerce(v.string(), s => s.toUpperCase());
 *
 * @example
 * // Parse string to number
 * const parseNum = v.coerce(v.string(), s => parseInt(s, 10));
 * type Out = InferOutput<typeof parseNum>; // number
 *
 * @example
 * // Date to ISO string
 * const isoDate = v.coerce(v.date(), d => d.toISOString());
 * type Out = InferOutput<typeof isoDate>; // string
 *
 * @example
 * // Extract property from object
 * const getName = v.coerce(
 *   v.object({ name: v.string(), age: v.number() }),
 *   obj => obj.name
 * );
 * type Out = InferOutput<typeof getName>; // string
 */
declare function coerce<S extends VibSchema<any, any>, TOut>(schema: S, fn: (value: S[" vibInferred"]["1"]) => TOut): TransformSchema<InferInput<S>, TOut> & {
  wrapped: S;
};
/**
 * Alias for coerce - transform wrapper.
 */
declare const map: typeof coerce;
//#endregion
//#region src/validation/V.d.ts
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
declare namespace V {
  /**
   * Type-level string schema.
   * @example V.String - Required string
   * @example V.String<{ optional: true }> - Optional string
   * @example V.String<{ nullable: true }> - Nullable string
   * @example V.String<{ array: true }> - Array of strings
   */
  type String<Opts extends ScalarOptions<string, any> | undefined = undefined> = StringSchema<ComputeInput<string, Opts>, ComputeOutput<string, Opts>>;
  /**
   * Type-level number schema.
   * @example V.Number - Required number
   * @example V.Number<{ optional: true }> - Optional number
   */
  type Number<Opts extends ScalarOptions<number, any> | undefined = undefined> = NumberSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
  /**
   * Type-level integer schema.
   */
  type Integer<Opts extends ScalarOptions<number, any> | undefined = undefined> = IntegerSchema<ComputeInput<number, Opts>, ComputeOutput<number, Opts>>;
  /**
   * Type-level boolean schema.
   */
  type Boolean<Opts extends ScalarOptions<boolean, any> | undefined = undefined> = BooleanSchema<ComputeInput<boolean, Opts>, ComputeOutput<boolean, Opts>>;
  /**
   * Type-level bigint schema.
   */
  type BigInt<Opts extends ScalarOptions<bigint, any> | undefined = undefined> = BigIntSchema<ComputeInput<bigint, Opts>, ComputeOutput<bigint, Opts>>;
  /**
   * Type-level Date schema (JavaScript Date object).
   */
  type Date<Opts extends ScalarOptions<globalThis.Date, any> | undefined = undefined> = DateSchema<ComputeInput<globalThis.Date, Opts>, ComputeOutput<globalThis.Date, Opts>>;
  /**
   * Type-level ISO timestamp schema (accepts string | Date, outputs string).
   */
  type IsoTimestamp<Opts extends ScalarOptions<string, any> | undefined = undefined> = IsoTimestampSchema<ComputeInput<string | globalThis.Date, Opts>, ComputeOutput<string, Opts>>;
  /**
   * Type-level ISO date schema (accepts string | Date, outputs string YYYY-MM-DD).
   */
  type IsoDate<Opts extends ScalarOptions<string, any> | undefined = undefined> = IsoDateSchema<ComputeInput<string | globalThis.Date, Opts>, ComputeOutput<string, Opts>>;
  /**
   * Type-level ISO time schema (accepts string | Date, outputs string HH:MM:SS).
   */
  type IsoTime<Opts extends ScalarOptions<string, any> | undefined = undefined> = IsoTimeSchema<ComputeInput<string | globalThis.Date, Opts>, ComputeOutput<string, Opts>>;
  /**
   * Type-level JSON schema.
   */
  type Json<Opts extends ScalarOptions<JsonValue, any> | undefined = undefined> = JsonSchema<ComputeInput<JsonValue, Opts>, ComputeOutput<JsonValue, Opts>>;
  /**
   * Type-level blob schema (Uint8Array or Buffer-like).
   */
  type Blob<Opts extends ScalarOptions<Uint8Array, any> | undefined = undefined> = BlobSchema<ComputeInput<Uint8Array, Opts>, ComputeOutput<Uint8Array, Opts>>;
  /**
   * Type-level vector schema (number array for embeddings).
   */
  type Vector<Opts extends ScalarOptions<number[], any> | undefined = undefined> = VectorSchema<ComputeInput<number[], Opts>, ComputeOutput<number[], Opts>>;
  /**
   * Type-level point schema (geographic coordinates).
   */
  type Point<Opts extends ScalarOptions<{
    x: number;
    y: number;
  }, any> | undefined = undefined> = PointSchema<ComputeInput<{
    x: number;
    y: number;
  }, Opts>, ComputeOutput<{
    x: number;
    y: number;
  }, Opts>>;
  /**
   * Type-level object schema.
   * @example V.Object<{ name: V.String; age: V.Number }>
   * @example V.Object<{ name: V.String }, { partial: false }> - All required
   */
  type Object<TEntries, TOpts extends ObjectOptions | undefined = undefined> = ObjectSchema<TEntries, TOpts>;
  /**
   * Type-level from object schema.
   * @example V.FromObject<{ name: V.String }, "name"> - Object with name field
   */
  type FromObject<TObject extends Record<string, any>, TPath extends string, TOpts extends ObjectOptions | undefined = undefined> = ObjectSchema<ComputeEntries<TObject, TPath>, TOpts>;
  type FromKeys<TKeys extends string[], TSchema extends VibSchema<any, any>, TOpts extends ObjectOptions | undefined = undefined> = ObjectSchema<ComputeEntriesFromKeys<TKeys, TSchema>, TOpts>;
  /**
   * Type-level array schema.
   * @example V.Array<V.String> - Array of strings
   */
  type Array<TItem extends VibSchema<any, any>> = ArraySchema<TItem>;
  /**
   * Type-level union schema.
   * @example V.Union<[V.String, V.Number]>
   */
  type Union<TOptions extends readonly VibSchema<any, any>[]> = UnionSchema<TOptions>;
  /**
   * Type-level enum schema.
   * @example V.Enum<["active", "inactive", "pending"]>
   */
  type Enum<TValues extends string[], Opts extends ScalarOptions<TValues[number], any> | undefined = undefined> = EnumSchema<TValues, ComputeInput<TValues[number], Opts>, ComputeOutput<TValues[number], Opts>>;
  /**
   * Type-level literal schema.
   * @example V.Literal<"active">
   */
  type Literal<TValue extends LiteralValue> = LiteralSchema<TValue>;
  /**
   * Type-level record schema (dictionary with uniform value type).
   * @example V.Record<V.String, V.Number>
   */
  type VRecord<TKey extends VibSchema<any, string>, TValue extends VibSchema<any, any>> = RecordSchema<TKey, TValue>;
  /**
   * Type-level optional schema.
   * @example V.Optional<V.String> - string | undefined
   */
  type Optional<TWrapped extends WrappableSchema, TDefault = undefined> = OptionalSchema<TWrapped, TDefault>;
  /**
   * Type-level nullable schema.
   * @example V.Nullable<V.String> - string | null
   */
  type Nullable<TWrapped extends VibSchema<any, any>> = NullableSchema<TWrapped>;
  type MaybeNullable<TWrapped extends VibSchema<any, any>, TIsNullable extends boolean> = TIsNullable extends true ? NullableSchema<TWrapped> : TWrapped;
  /**
   * Type-level transform schema.
   * @example V.Transform<string, number> - transforms string input to number output
   */
  type Transform<TInput, TOutput> = TransformSchema<TInput, TOutput>;
  /**
   * Type-level pipe schema for chaining validations.
   * @example V.Pipe<V.String, [TrimAction, LowercaseAction]>
   */
  type Pipe<TSchema extends VibSchema<any, any>, TActions extends readonly PipeAction<any, any>[]> = PipeSchema<TSchema, TActions>;
  type Coerce<TWrapped extends VibSchema<any, any>, TOutput> = TransformSchema<InferInput<TWrapped>, TOutput> & {
    wrapped: TWrapped;
  };
  type ShorthandFilter<TWrapped extends VibSchema<any, any>> = Coerce<TWrapped, {
    equals: TWrapped[" vibInferred"]["1"];
  }>;
  type ShorthandUpdate<TWrapped extends VibSchema<any, any>> = Coerce<TWrapped, {
    set: TWrapped[" vibInferred"]["1"];
  }>;
  type ShorthandArray<TWrapped extends VibSchema<any, any>> = Coerce<TWrapped, [TWrapped[" vibInferred"]["1"]]>;
  type SingleOrArray<TWrapped extends VibSchema<any, any>> = V.Union<readonly [V.Coerce<TWrapped, [TWrapped[" vibInferred"]["1"]]>, V.Array<TWrapped>]>;
  /**
   * Extract input type from a V.* type or VibSchema.
   */
  type Input<T> = InferInput<T>;
  /**
   * Extract output type from a V.* type or VibSchema.
   */
  type Output<T> = InferOutput<T>;
  /**
   * Any VibSchema - useful for generic constraints.
   */
  type Schema<TInput = unknown, TOutput = TInput> = VibSchema<TInput, TOutput>;
}
//#endregion
//#region src/validation/index.d.ts
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
declare const v: {
  readonly string: typeof string;
  readonly number: typeof number;
  readonly integer: typeof integer;
  readonly boolean: typeof boolean;
  readonly bigint: typeof bigint;
  readonly literal: typeof literal;
  readonly enum: typeof enum_;
  readonly json: typeof json;
  readonly date: typeof date;
  readonly isoTimestamp: typeof isoTimestamp;
  readonly isoDate: typeof isoDate;
  readonly isoTime: typeof isoTime;
  readonly instance: typeof instance;
  readonly blob: typeof blob;
  readonly vector: typeof vector;
  readonly point: typeof point;
  readonly array: typeof array;
  readonly nullable: typeof nullable;
  readonly maybeNullable: typeof maybeNullable;
  readonly optional: typeof optional;
  readonly nonNullable: typeof nonNullable;
  readonly nonOptional: typeof nonOptional;
  readonly required: typeof nonOptional;
  readonly nonArray: typeof nonArray;
  readonly element: typeof nonArray;
  readonly object: typeof object;
  readonly fromObject: typeof fromObject;
  readonly union: typeof union;
  readonly pipe: typeof pipe;
  readonly transformAction: typeof transform;
  readonly record: typeof record;
  readonly fromKeys: typeof fromKeys;
  readonly coerce: typeof coerce;
  readonly map: typeof coerce;
};
declare const parse: <const S extends VibSchema>(schema: S, value: unknown) => Awaited<ReturnType<(typeof schema)["~standard"]["validate"]>>;
//#endregion
export { nonOptional as $, createSchema as $t, BasePointSchema as A, EnumSchema as At, object as B, BaseBlobSchema as Bt, vector as C, JsonSchemaTarget as Cn, isoTimestamp as Ct, StringSchema as D, InstanceSchema as Dt, BaseStringSchema as E, validateIsoTimestamp as Et, OptionalSchema as F, validateDate as Ft, integer as G, BigIntSchema as Gt, BaseNumberSchema as H, blob as Ht, optional as I, BaseBooleanSchema as It, validateNumber as J, ArraySchema as Jt, number as K, bigint as Kt, ObjectEntries as L, BooleanSchema as Lt, PointSchema as M, BaseDateSchema as Mt, point as N, DateSchema as Nt, string as O, instance as Ot, validatePoint as P, date as Pt, NonOptionalSchema as Q, buildValidator as Qt, ObjectOptions as R, boolean as Rt, createVectorValidator as S, JsonSchemaOptions as Sn, isoTime as St, union as T, validateIsoTime as Tt, IntegerSchema as U, validateBlob as Ut, type BaseIntegerSchema as V, BlobSchema as Vt, NumberSchema as W, BaseBigIntSchema as Wt, maybeNullable as X, createJsonSchemaConverter as Xt, NullableSchema as Y, array as Yt, nullable as Z, toJsonSchema as Zt, FromObjectOptions as _, ValidationSuccess as _n, BaseIsoTimestampSchema as _t, coerce as a, ComputeInput as an, nonArray as at, BaseVectorSchema as b, JsonSchema$1 as bn, IsoTimestampSchema as bt, RecordSchema as c, InferInputShape as cn, literal as ct, PipeAction as d, Prettify as dn, JsonValue as dt, fail as en, required as et, PipeSchema as f, ScalarOptions as fn, isJsonValue as ft, AllPathsToSchemas as g, ValidationResult as gn, BaseIsoTimeSchema as gt, transform as h, ValidationIssue as hn, BaseIsoDateSchema as ht, TransformSchema as i, Cast as in, element as it, Point as j, enum_ as jt, validateString as k, BaseEnumSchema as kt, fromKeys as l, InferOutput as ln, BaseJsonSchema as lt, pipe as m, ValidationFailure as mn, validateJson as mt, v as n, ok as nn, nonNullable as nt, map as o, ComputeOutput as on, LiteralSchema as ot, TransformAction as p, ThunkCast as pn, json as pt, validateInteger as q, validateBigInt as qt, V as r, validateSchema as rn, NonArraySchema as rt, FromKeysOptions as s, InferInput as sn, LiteralValue as st, parse as t, getDefault as tn, NonNullableSchema as tt, record as u, InferOutputShape as un, JsonSchema as ut, FromObjectSchema as v, VibSchema as vn, IsoDateSchema as vt, UnionSchema as w, inferred as wn, validateIsoDate as wt, VectorSchema as x, JsonSchemaConverter as xn, isoDate as xt, fromObject as y, isVibSchema as yn, IsoTimeSchema as yt, ObjectSchema as z, validateBoolean as zt };
//# sourceMappingURL=index-DfCVh_Ql.d.mts.map