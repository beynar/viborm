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

type ReduceOmit<T, O> = Omit<
  T,
  Extract<DefinitelyOmittedKeys<O> | MaybeOmittedKeys<O>, keyof T>
> &
  Partial<Pick<T, Extract<MaybeOmittedKeys<O>, keyof T>>>;

/**
 * An `omit` that MAY be absent decides nothing on its own, so every key it
 * names softens to a widened `boolean` — which {@link ReduceOmit} renders as an
 * OPTIONAL key, the same convention a widened flag already follows. It is the
 * spread idiom's other half: `{ ...(cond && { omit: { title: true } }) }` types
 * `omit` as optional, and promising `title` outright would be a lie exactly
 * when `cond` holds.
 */
type SoftenNodeOmit<O> = { [F in keyof O]: boolean };

export type ApplyOmit<T, O> = [O] extends [undefined]
  ? T
  : undefined extends O
    ? ReduceOmit<T, SoftenNodeOmit<Exclude<O, undefined>>>
    : ReduceOmit<T, O>;

/**
 * The value a node STATES under one projection key, or `undefined` when it
 * states none.
 *
 * INDEXED ACCESS, not `Node extends { omit: infer O }`: a conditional matches a
 * REQUIRED property, so it reads an OPTIONAL one — the exact shape TypeScript
 * gives the spread idiom, `{ ...(cond && { select: sel }) }` -> `{ select?: Sel }`
 * — as "no such key", and the key would silently decide nothing. Indexed access
 * reports it as `Sel | undefined`, which is the truth: only the runtime knows.
 *
 * An object with a string INDEX SIGNATURE states nothing, for the same reason
 * `NoExtraClauseKeys` (./types.ts) refuses to police one: it declares no spelled
 * key, and reading `Record<string, unknown>["select"]` as a projection would
 * turn every dynamically-built payload into the ambiguous arm.
 */
type NodeKey<Node, Key extends string> = string extends keyof Node
  ? undefined
  : Key extends keyof Node
    ? Node[Extract<Key, keyof Node>]
    : undefined;

/**
 * Exported because the CLIENT-level default is folded into the same key before
 * inference runs (`WithClientOmit`, ./types.ts): one node, one `omit`, one
 * reduction — the same shape the runtime hands the engine after
 * `applyClientOmit` has rewritten the payload.
 */
export type NodeOmit<Node> = NodeKey<Node, "omit">;

/**
 * The parse boundary treats an explicitly-`undefined` key as an ABSENT key
 * (`src/validation/primitives/object.ts`), which is what makes the
 * spread-an-optional idiom work; so `{ select: undefined }` and `{}` are the
 * same payload, and this helper reports them the same way.
 */
export type NodeSelect<Node> = NodeKey<Node, "select">;

export type NodeInclude<Node> = NodeKey<Node, "include">;

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
 *
 * The dispatch is on the select VALUE, not on key presence. `{ select: undefined }`
 * is the spread-an-optional idiom collapsed to a literal `undefined`, and the
 * parse boundary hands the engine a payload with no projection at all — so it
 * returns the full default row, exactly like `{}`. Reading it as "a selection of
 * nothing" typed that call `{}`, and `rows[0].id` stopped compiling on a call
 * that returns `id` at runtime.
 *
 * The two refusals — `select` + `include`, `select` + `omit` — are read the same
 * way: a sibling key that is present but `undefined` is not a second projection,
 * so it does not turn a legal payload into `never`.
 */
export type InferSelectInclude<
  S extends ModelState,
  Args,
  Selection = NodeSelect<Args>,
> = [Selection] extends [undefined]
  ? InferUnselectedRow<S, Args>
  : undefined extends Selection
    ? // Only the runtime value decides, so the result is the honest UNION of
      // both worlds — the same ambiguous arm `BulkWriteResult` takes for
      // `updateMany({ select: maybeSelect })`. Collapsing it to the full row
      // (which is what reading the key's PRESENCE did) claimed every column on a
      // call that returns one; collapsing it to the projection would claim the
      // opposite. A caller in this position narrows, which is exactly the choice
      // they deferred to runtime.
        | InferUnselectedRow<S, Args>
        | InferSelectedRow<S, Args, Exclude<Selection, undefined>>
    : InferSelectedRow<S, Args, Selection>;

/**
 * The row a node returns in the world where its `select` carries a value.
 *
 * `select` is exclusive with `include` and with `omit` — the parse boundary
 * refuses both pairs — so a sibling that DEFINITELY carries a value makes this
 * world impossible, and `never` is precisely the type of a value that is never
 * produced (the call throws). A sibling that merely MAY carry one leaves this
 * world reachable, and the union above keeps the other one.
 */
type InferSelectedRow<
  S extends ModelState,
  Args,
  Selection,
> = undefined extends NodeInclude<Args>
  ? undefined extends NodeOmit<Args>
    ? InferSelectResult<S, Selection>
    : never
  : never;

/**
 * The row a node returns when it states no `select`: the model's own output,
 * plus whatever `include` adds, reduced by the node's `omit`.
 *
 * An `include` that MAY be absent is read as ABSENT — the common ground of both
 * worlds — while a MAYBE `omit` softens instead (`ApplyOmit`). The asymmetry is
 * the direction of the lie: `include` only ADDS keys, so promising the smaller
 * row promises nothing that is missing at runtime, and the caller who wants the
 * relation spells the `include` definitely; `omit` REMOVES them, so reading a
 * maybe-omit as absent would promise a column the runtime may have dropped.
 */
type InferUnselectedRow<
  S extends ModelState,
  Args,
> = undefined extends NodeInclude<Args>
  ? ApplyOmit<InferModelOutput<S>, NodeOmit<Args>>
  : ApplyOmit<InferIncludeResult<S, NodeInclude<Args>>, NodeOmit<Args>>;

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
type InferRelationNodeResult<
  R extends AnyRelation,
  Node,
  NS = NodeSelect<Node>,
> = [NS] extends [undefined]
  ? UnselectedRelationNode<R, Node>
  : undefined extends NS
    ? // The same ambiguous arm the top-level node takes, one level down.
        | UnselectedRelationNode<R, Node>
        | InferNestedSelectResult<R, Exclude<NS, undefined>>
    : InferNestedSelectResult<R, NS>;

/** A relation node that states no `select`. */
type UnselectedRelationNode<
  R extends AnyRelation,
  Node,
  NI = NodeInclude<Node>,
> = undefined extends NI
  ? WrapRelation<
      R,
      ApplyOmit<InferModelOutput<GetTargetModelState<R>>, NodeOmit<Node>>
    >
  : WrapRelation<
      R,
      ApplyOmit<InferIncludeResult<GetTargetModelState<R>, NI>, NodeOmit<Node>>
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
 *
 * THE RULE, and it is the RESULT PARSER's rule, not a guess:
 * `result-aggregate-parser.ts` marks `_sum` / `_min` / `_max` as `typed` and
 * decodes them through the FIELD'S OWN scalar decoder, so those three come back
 * spelled exactly like the column — `_sum` of an `s.bigInt()` is a `bigint`,
 * `_sum` of an `s.decimal()` is an exact string. Only `_avg` takes the
 * widen-to-number path, and even it stays a string for a decimal, because an
 * average of decimals is still a decimal the database computed exactly.
 *
 * `_sum` used to be typed `number` for everything but a decimal, which made
 * `agg._sum.big * 2` type-check and then throw "Cannot mix BigInt and other
 * types" — and, worse, `agg._sum.big === 150` silently false. The decoder is the
 * half that is pinned behaviorally (tests/drivers/scalar-roundtrip-behavior.ts),
 * so the type follows it.
 */
export type AggregateResultType<T extends ModelShape, Args> = Prettify<{
  [K in keyof Args as K extends `_${string}` ? K : never]: K extends "_count"
    ? Args[K] extends true
      ? number
      : Args[K] extends object
        ? { [F in keyof Args[K]]: number }
        : never
    : K extends "_sum"
      ? Args[K] extends object
        ? {
            // Decoded through the field's own scalar: bigint -> bigint,
            // decimal -> string, int/float -> number.
            [F in keyof Args[K]]:
              | (F extends ScalarKeys<T> ? InferScalarBase<T[F]> : number)
              | null;
          }
        : never
      : K extends "_avg"
        ? Args[K] extends object
          ? {
              // An average OF decimals is still a decimal; every other numeric
              // widens to a JS number, bigint included.
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
