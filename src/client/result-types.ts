/**
 * Result Types for ORM Client
 *
 * Provides type inference for operation results based on select/include args.
 * Works directly with ModelState for full type context (including omit settings).
 */

import type { Model, ModelState } from "@schema/model";
import type { ModelShape } from "@schema/model/helper";
import type { AnyRelation } from "@schema/relation";
import type { Scalar, ScalarState } from "@schema/scalars";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { Prettify } from "@validation";
import type { EnumValues } from "@validation/primitives/enum";

// =============================================================================
// SCALAR OUTPUT TYPE MAPPING
// =============================================================================

/**
 * Maps VibORM scalar types to their DATABASE RESULT types.
 * This is what the ORM returns after querying the database.
 *
 * Key difference from validation schema output:
 * - datetime/date/time: returns Date (not ISO string)
 * - json: inferred from custom schema if present, otherwise unknown
 * - enum: inferred from schema values
 */
type ScalarResultTypeMap = {
  string: string;
  int: number;
  float: number;
  // A decimal reads back as its exact canonical spelling. A JS number could not
  // carry the value a `numeric` / `DECIMAL(65,30)` column actually holds.
  decimal: string;
  boolean: boolean;
  datetime: Date; // Database results are Date objects, not ISO strings
  date: Date;
  time: string; // Time-only value as "HH:MM:SS" string
  bigint: bigint;
  json: unknown;
  blob: Uint8Array;
  vector: number[];
  point: { x: number; y: number };
  enum: string;
};

/**
 * Extract the ScalarState from a Scalar using infer to preserve literal types.
 */
type ExtractScalarState<F> = F extends { "~": { state: infer S } }
  ? S extends ScalarState
    ? S
    : never
  : never;

/**
 * Get the base scalar type for a field, handling custom schemas.
 * For json/enum scalars with custom schemas, infer from the schema.
 * For datetime fields, always return Date (regardless of validation schema output).
 *
 * Note: Enum types return `string` when accessed through relations due to type widening.
 * See BUG_REPORT_RELATION_TYPES.md Bug 1 for details.
 */
type GetScalarResultType<F extends Scalar> =
  ExtractScalarState<F> extends infer S
    ? S extends ScalarState
      ? S["type"] extends "json"
        ? S["schema"] extends StandardSchemaV1<any, infer O>
          ? O
          : unknown
        : S["type"] extends "enum"
          ? EnumValues<S["base"]>[number]
          : ScalarResultTypeMap[S["type"]]
      : unknown
    : unknown;

/**
 * Apply nullable wrapper based on scalar state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyNullable<T, Nullable> = [Nullable] extends [true] ? T | null : T;

/**
 * Apply array wrapper based on scalar state.
 * Uses non-distributive check to handle boolean literals correctly.
 */
type ApplyArray<T, IsArray> = [IsArray] extends [true] ? T[] : T;

/**
 * Infer the DATABASE RESULT type for a scalar.
 *
 * This is the canonical helper for inferring output types from scalars.
 * It correctly handles:
 * - All scalar types with proper DB result mapping (datetime → Date)
 * - Custom schemas for json/enum scalars
 * - Nullable scalars
 * - Array scalars
 *
 * @example
 * // For s.dateTime().nullable() → Date | null
 * // For s.string().array() → string[]
 * // For s.json().schema(z.object({...})) → { ... }
 */

export type InferScalarOutput<F extends Scalar> =
  ExtractScalarState<F> extends infer S
    ? S extends ScalarState
      ? ApplyNullable<
          ApplyArray<GetScalarResultType<F>, S["array"]>,
          S["nullable"]
        >
      : never
    : never;

// =============================================================================
// BATCH PAYLOAD
// =============================================================================

/**
 * Result for batch operations (createMany, updateMany, deleteMany)
 */
export interface BatchPayload {
  count: number;
}

// =============================================================================
// COUNT RESULT
// =============================================================================

/**
 * Result type for count operations
 * Supports select for per-field counts like Prisma: count({ select: { _all: true, name: true } })
 */
export type CountResultType<Args> = Args extends { select: infer S }
  ? Prettify<{ [K in keyof S as S[K] extends true ? K : never]: number }>
  : number;

// =============================================================================
// MODEL STATE HELPERS
// =============================================================================

/**
 * Get the target model's state from a relation
 */
export type GetTargetModelState<R extends AnyRelation> =
  R["~"]["state"]["getter"] extends () => infer T
    ? T extends Model<infer S>
      ? S extends ModelState
        ? S
        : never
      : never
    : never;

/**
 * Infer the output type for a model, respecting omit settings.
 * Uses InferScalarOutput for correct DB result types (e.g., Date for datetime).
 */
export type InferModelOutput<S extends ModelState> =
  S["omit"] extends Record<string, true>
    ? Omit<
        {
          [K in keyof S["scalars"]]: S["scalars"][K] extends Scalar
            ? InferScalarOutput<S["scalars"][K]>
            : never;
        },
        keyof S["omit"]
      >
    : {
        [K in keyof S["scalars"]]: S["scalars"][K] extends Scalar
          ? InferScalarOutput<S["scalars"][K]>
          : never;
      };

// =============================================================================
// OMIT
// =============================================================================

/**
 * `omit` at the TYPE level.
 *
 * Three cases, mirroring what the runtime can and cannot know:
 *  - `true` — the key is gone;
 *  - `false` (or absent) — the key stays;
 *  - a widened `boolean` (a variable, a spread, `cond ? true : false`) — only
 *    the runtime decides, so the key becomes OPTIONAL rather than being guessed
 *    into one arm. Claiming it is present would be a lie exactly when the flag
 *    is `true`, which is the case a caller writes this for.
 *
 * Model-level `.omit()` never appears here: those fields are absent from
 * `InferModelOutput` already, and the `omit` schema has no key to name them
 * with (see `src/validation/model/core/projection.ts`).
 */
type DefinitelyOmittedKeys<O> = {
  [K in keyof O]: [O[K]] extends [true] ? K : never;
}[keyof O];

type MaybeOmittedKeys<O> = {
  [K in keyof O]: [O[K]] extends [true]
    ? never
    : [O[K]] extends [false]
      ? never
      : boolean extends O[K]
        ? K
        : never;
}[keyof O];

export type ApplyOmit<T, O> = [O] extends [undefined]
  ? T
  : Omit<T, Extract<DefinitelyOmittedKeys<O> | MaybeOmittedKeys<O>, keyof T>> &
      Partial<Pick<T, Extract<MaybeOmittedKeys<O>, keyof T>>>;

/** The `omit` a node carries, or `undefined` when it carries none. */
type NodeOmit<Node> = Node extends { omit: infer O } ? O : undefined;

/**
 * Get relation type (oneToMany, manyToMany, oneToOne, manyToOne)
 */
export type GetRelationType<R extends AnyRelation> = R["~"]["state"]["type"];

/**
 * Check if a relation is optional
 */
export type GetRelationOptional<R extends AnyRelation> =
  R["~"]["state"]["optional"];

// =============================================================================
// RELATION RESULT
// =============================================================================

/**
 * Result for a relation when included
 * - To-many relations return arrays
 * - To-one relations return single objects (nullable if optional)
 */
/**
 * The relation's cardinality wrapper, applied to an already-built element type:
 * to-many is an array, an optional to-one is nullable, a required to-one is the
 * bare object. Factored out so the omit-aware node inference below wraps the
 * SAME way the three original helpers do.
 */
type WrapRelation<R extends AnyRelation, T> = [GetRelationType<R>] extends [
  "oneToMany" | "manyToMany",
]
  ? T[]
  : [GetRelationOptional<R>] extends [true]
    ? T | null
    : T;

export type InferRelationResult<R extends AnyRelation> = WrapRelation<
  R,
  InferModelOutput<GetTargetModelState<R>>
>;

// =============================================================================
// SELECT/INCLUDE RESULT INFERENCE
// =============================================================================

/**
 * Infer result from select/include args
 * - select: ONLY returns selected fields
 * - include: returns base model + included relations
 * - neither: returns base model output
 */
export type InferSelectInclude<S extends ModelState, Args> = Args extends {
  select: unknown;
  include: unknown;
}
  ? never
  : Args extends { select: unknown; omit: unknown }
    ? never
    : Args extends { select: infer Selection }
      ? InferSelectResult<S, Selection>
      : Args extends { include: infer Include }
        ? ApplyOmit<InferIncludeResult<S, Include>, NodeOmit<Args>>
        : ApplyOmit<InferModelOutput<S>, NodeOmit<Args>>;

/**
 * Result when select is provided - ONLY selected fields are returned
 */
export type InferSelectResult<S extends ModelState, Selection> = Prettify<
  InferSelectedFields<S, Selection> &
    InferVectorDistanceSelection<S, Selection> &
    InferRelationCountSelection<S, Selection>
>;

type InferSelectedFields<S extends ModelState, Selection> = {
  [K in keyof Selection & keyof S["shape"] as S["shape"][K] extends Scalar
    ? Selection[K] extends true
      ? K
      : never
    : Selection[K] extends true | object
      ? K
      : never]: S["shape"][K] extends Scalar
    ? InferScalarOutput<S["shape"][K]>
    : S["shape"][K] extends AnyRelation
      ? Selection[K] extends true
        ? InferRelationResult<S["shape"][K]>
        : Selection[K] extends object
          ? InferRelationNodeResult<S["shape"][K], Selection[K]>
          : never
      : never;
};

type VectorScalarFieldKeys<S extends ModelState> = {
  [K in keyof S["shape"]]: S["shape"][K] extends Scalar
    ? [ExtractScalarState<S["shape"][K]>] extends [ScalarState<"vector">]
      ? K
      : never
    : never;
}[keyof S["shape"]];

type SelectedVectorDistanceKeys<S extends ModelState, Selection> = {
  [K in keyof Selection & VectorScalarFieldKeys<S>]: Selection[K] extends {
    _distance: unknown;
  }
    ? K
    : never;
}[keyof Selection & VectorScalarFieldKeys<S>];

type InferVectorDistanceSelection<S extends ModelState, Selection> = [
  SelectedVectorDistanceKeys<S, Selection>,
] extends [never]
  ? {}
  : { _distance: number };

/**
 * To-many (list) relation keys — the exact set Prisma's `_count: true`
 * shorthand expands to (`<Model>CountOutputType` holds only list relations).
 */
type ToManyRelationKeys<S extends ModelState> = {
  [K in keyof S["relations"]]: S["relations"][K] extends AnyRelation
    ? [GetRelationType<S["relations"][K]>] extends ["oneToMany" | "manyToMany"]
      ? K
      : never
    : never;
}[keyof S["relations"]];

type InferRelationCountSelection<
  S extends ModelState,
  Selection,
> = Selection extends { _count: { select: infer CountSelection } }
  ? {
      _count: {
        [K in keyof CountSelection &
          keyof S["relations"] as CountSelection[K] extends true | object
          ? K
          : never]: number;
      };
    }
  : Selection extends { _count: true }
    ? { _count: { [K in ToManyRelationKeys<S>]: number } }
    : {};

/**
 * Result when include is provided - base result + included relations
 */
export type InferIncludeResult<S extends ModelState, Include> = Prettify<
  InferModelOutput<S> & {
    [K in keyof Include & keyof S["relations"] as Include[K] extends
      | true
      | object
      ? K
      : never]: S["relations"][K] extends AnyRelation
      ? Include[K] extends true
        ? InferRelationResult<S["relations"][K]>
        : Include[K] extends object
          ? InferRelationNodeResult<S["relations"][K], Include[K]>
          : never
      : never;
  } & InferRelationCountSelection<S, Include>
>;

/**
 * Nested select result for a relation
 */
export type InferNestedSelectResult<R extends AnyRelation, NS> = WrapRelation<
  R,
  InferSelectResult<GetTargetModelState<R>, NS>
>;

/**
 * Nested include result for a relation
 */
export type InferNestedIncludeResult<R extends AnyRelation, NI> = WrapRelation<
  R,
  InferIncludeResult<GetTargetModelState<R>, NI>
>;

/**
 * A relation node in `select`/`include` position: `{ select }`, `{ include }`,
 * `{ omit }`, pagination-only (`{ where, take, … }`), or any combination the
 * parse boundary accepts. `select` wins outright (it states the projection
 * positively, and `select` + `omit` is refused); otherwise the node's `omit`
 * reduces the relation's own scalars, with `include` still adding relations on
 * top. Pagination-only nodes fall through to the full relation payload, which
 * is what they always did.
 */
type InferRelationNodeResult<R extends AnyRelation, Node> = Node extends {
  select: infer NS;
}
  ? InferNestedSelectResult<R, NS>
  : Node extends { include: infer NI }
    ? WrapRelation<
        R,
        ApplyOmit<
          InferIncludeResult<GetTargetModelState<R>, NI>,
          NodeOmit<Node>
        >
      >
    : WrapRelation<
        R,
        ApplyOmit<InferModelOutput<GetTargetModelState<R>>, NodeOmit<Node>>
      >;

// =============================================================================
// AGGREGATE RESULT TYPES
// =============================================================================

/**
 * Extract scalar keys from a ModelShape
 */
type ScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar ? K : never;
}[keyof T];

/**
 * Infer base type from a scalar for aggregates.
 * Uses InferScalarOutput for correct DB result types.
 */
type InferScalarBase<F> = F extends Scalar ? InferScalarOutput<F> : never;

/** True when the scalar is a decimal, whose aggregates stay exact strings. */
type IsDecimalScalar<F> =
  ExtractScalarState<F> extends { type: "decimal" } ? true : false;

/**
 * Result type for aggregate operations
 * Dynamically typed based on which aggregates are requested
 */
export type AggregateResultType<T extends ModelShape, Args> = Prettify<{
  [K in keyof Args as K extends `_${string}` ? K : never]: K extends "_count"
    ? Args[K] extends true
      ? number
      : Args[K] extends object
        ? { [F in keyof Args[K]]: number }
        : never
    : K extends "_avg" | "_sum"
      ? Args[K] extends object
        ? {
            // A sum or average OF decimals is still a decimal — the database
            // computes it exactly, so it comes back as a string like the column
            // does. Every other numeric aggregates to a JS number.
            [F in keyof Args[K]]:
              | (F extends ScalarKeys<T>
                  ? IsDecimalScalar<T[F]> extends true
                    ? string
                    : number
                  : number)
              | null;
          }
        : never
      : K extends "_min" | "_max"
        ? Args[K] extends object
          ? {
              [F in keyof Args[K]]: F extends ScalarKeys<T>
                ? InferScalarBase<T[F]> | null
                : never;
            }
          : never
        : never;
}>;

// =============================================================================
// GROUPBY RESULT TYPES
// =============================================================================

/**
 * Result type for groupBy operations
 * Includes the grouped-by fields plus any requested aggregates
 */
export type GroupByResultType<T extends ModelShape, Args> = Args extends {
  by: infer B;
}
  ? Prettify<
      // Grouped-by fields
      (B extends readonly (infer K)[]
        ? K extends ScalarKeys<T> & keyof T
          ? { [F in K]: InferScalarBase<T[F]> }
          : never
        : B extends ScalarKeys<T> & keyof T
          ? { [F in B]: InferScalarBase<T[F]> }
          : never) &
        // Aggregate fields
        AggregateResultType<T, Args>
    >
  : never;
