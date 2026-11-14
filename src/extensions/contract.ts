/**
 * The types of the extension vocabulary. Types only: the builders that make
 * each value live beside them (`extension.ts`, `call.ts`, `rule.ts`, …).
 *
 * One mechanism serves every part: each builder is a function generic over
 * the TARGET it is typed against (`Target`: the client's config, its
 * extension state, and what the earlier parts of the same extension
 * declared). TypeScript infers the target from the type `$extends` expects
 * back, through `extension(...)`, so every handler is typed against the
 * client the extension is applied to. `parts<Of>()` fixes it for an
 * extension written apart from any client.
 */

import type { ClientTypeState, VibORMConfig } from "@client/client";
import type { ClientSchema, LinkedClientConfig } from "@client/schema-links";
import type {
  CacheableOperations,
  ClientRowsContext,
  ContextualOperationResult,
  MutationOperations,
  OperationPayload,
  Operations,
} from "@client/types";
import type { FieldRef } from "@schema/field-ref";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { NoControls, PlacedControl, StampedFields } from "./controls";
import type {
  ExtensionClientScope,
  ExtensionStateConstraint,
  MergeModelMethods,
} from "./methods";
import type { WriteOutcome } from "./query";
import type { RequestTransformPatch } from "./request";
import type {
  DefinitionResultFields,
  MergeResultFields,
  ResultInference,
} from "./result-types";
import type { WriteKind } from "./written";

type NoMethods = Record<never, never>;
type NoFields = Record<never, never>;

// =============================================================================
// FACTS: what one part contributes to the client's extension state
// =============================================================================

/**
 * The facts a part can contribute: the members of `ClientExtensionState` a
 * chain accumulates, `omit` (the fields a default leaves out, which joins the
 * client's own omission), `consumer` (the part was typed against a result,
 * so a later rule that hides rows would make its type lie), `cache` (the
 * official cache) and `verbs` (what a rule's `gate` and `facts` add to the
 * delegates, in the form the projected types read).
 */
export interface Facts<
  Client extends object = NoMethods,
  Models extends object = NoMethods,
  Controls extends object = NoControls,
  Rows extends string = never,
  Data = never,
  Result extends object = NoFields,
  Omit extends object = NoFields,
  Consumer extends boolean = false,
  Cache extends boolean = false,
  Verbs extends object = NoFields,
> {
  readonly client: Client;
  readonly models: Models;
  readonly controls: Controls;
  readonly rows: Rows;
  readonly data: Data;
  readonly result: Result;
  readonly omit: Omit;
  readonly consumer: Consumer;
  readonly cache: Cache;
  readonly verbs: Verbs;
}

export type EmptyFacts = Facts;

export type AnyFacts = Facts<
  object,
  object,
  object,
  string,
  unknown,
  object,
  object,
  boolean,
  boolean,
  object
>;

type MergeObjects<Left extends object, Right extends object> = [
  keyof Right,
] extends [never]
  ? Left
  : [keyof Left] extends [never]
    ? Right
    : {
        readonly [M in keyof Left | keyof Right]: (M extends keyof Left
          ? Left[M]
          : NoFields) &
          (M extends keyof Right ? Right[M] : NoFields);
      };

/** Two parts' facts as one: the later part wins a computed field's name. */
export type MergeFacts<Left extends AnyFacts, Right extends AnyFacts> = Facts<
  Left["client"] & Right["client"],
  MergeModelMethods<Left["models"], Right["models"]>,
  Left["controls"] & Right["controls"],
  Left["rows"] | Right["rows"],
  Left["data"] | Right["data"],
  MergeResultFields<Left["result"], Right["result"]>,
  MergeObjects<Left["omit"], Right["omit"]>,
  Left["consumer"] extends true
    ? true
    : Right["consumer"] extends true
      ? true
      : false,
  Left["cache"] extends true ? true : Right["cache"],
  MergeObjects<Left["verbs"], Right["verbs"]>
>;

// =============================================================================
// TARGET, PART, EXTENSION
// =============================================================================

/**
 * What a part is typed against: the client's config and extension state,
 * and the facts the earlier parts of the same extension contribute (`own`:
 * a part sees the arguments its siblings before it declare).
 */
export interface Target<
  C extends VibORMConfig = VibORMConfig,
  X extends ExtensionStateConstraint = ExtensionStateConstraint,
  Own extends AnyFacts = EmptyFacts,
> {
  readonly config: C;
  readonly state: X;
  readonly own: Own;
}

export type AnyTarget = Target<
  VibORMConfig,
  ExtensionStateConstraint,
  AnyFacts
>;

/**
 * What a part bound to a target accepts: that client, whatever the earlier
 * parts of its extension declared.
 */
export type Within<Bound extends AnyTarget | undefined> =
  Bound extends AnyTarget
    ? Target<Bound["config"], Bound["state"], AnyFacts>
    : AnyTarget;

/** The target the next part of an extension sees: this part's facts added. */
export type With<T extends AnyTarget, F extends AnyFacts> = Target<
  T["config"],
  T["state"],
  MergeFacts<T["own"], F>
>;

declare const partFacts: unique symbol;

/**
 * One part: typed against `T` (contravariant: a part typed against a wider
 * client applies to a narrower one) and contributing `F`.
 */
export interface Part<in T extends AnyTarget, out F extends AnyFacts> {
  readonly [partFacts]: (target: T) => F;
}

declare const extensionFacts: unique symbol;

/** An immutable named list of parts, applied by `$extends`. */
export interface Extension<in T extends AnyTarget, out F extends AnyFacts> {
  readonly name: string;
  readonly [extensionFacts]: (target: T) => F;
}

export type SchemaOf<T extends AnyTarget> = ClientSchema<T["config"]>;
type ModelOf<T extends AnyTarget, M> = SchemaOf<T>[M & keyof SchemaOf<T>];
export type ModelName<T extends AnyTarget> = keyof SchemaOf<T> & string;

/** Every argument name a rule or a call of this part may read. */
export type KnownArgs<T extends AnyTarget> = Extract<
  keyof T["state"]["controls"] | keyof T["own"]["controls"],
  string
>;

/** The values a call receives for its own extension's arguments. */
type OwnValues<T extends AnyTarget> = {
  readonly [Name in keyof T["own"]["controls"]]?: T["own"]["controls"][Name] extends PlacedControl<
    infer Value
  >
    ? Value
    : never;
};

// =============================================================================
// extension(name, ...parts)
// =============================================================================

export type MergeAll<
  F1 extends AnyFacts,
  F2 extends AnyFacts,
  F3 extends AnyFacts,
  F4 extends AnyFacts,
  F5 extends AnyFacts,
  F6 extends AnyFacts,
  F7 extends AnyFacts,
  F8 extends AnyFacts,
> = MergeFacts<
  MergeFacts<
    MergeFacts<MergeFacts<F1, F2>, MergeFacts<F3, F4>>,
    MergeFacts<MergeFacts<F5, F6>, F7>
  >,
  F8
>;

/**
 * Parts are positional, not a rest parameter: a rest parameter's contextual
 * type is an element of a type parameter that a nested call cannot read
 * while it infers from its expected result (measured: `call`'s handler falls
 * back to the widest client). Positional parameters also let each part see
 * the facts of the parts before it (`With`). The runtime takes any number;
 * the types take eight.
 */
export type FreeExtension = <
  T extends AnyTarget,
  F1 extends AnyFacts = EmptyFacts,
  F2 extends AnyFacts = EmptyFacts,
  F3 extends AnyFacts = EmptyFacts,
  F4 extends AnyFacts = EmptyFacts,
  F5 extends AnyFacts = EmptyFacts,
  F6 extends AnyFacts = EmptyFacts,
  F7 extends AnyFacts = EmptyFacts,
  F8 extends AnyFacts = EmptyFacts,
>(
  name: string,
  p1?: Part<T, F1>,
  p2?: Part<With<T, F1>, F2>,
  p3?: Part<With<With<T, F1>, F2>, F3>,
  p4?: Part<With<With<With<T, F1>, F2>, F3>, F4>,
  p5?: Part<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>,
  p6?: Part<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>,
  p7?: Part<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
  p8?: Part<
    With<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
    F8
  >
) => Extension<T, MergeAll<F1, F2, F3, F4, F5, F6, F7, F8>>;

/**
 * The same with the target fixed (`parts<Of>()`): not generic in it, so its
 * parts are checked against the bound client, never an inferred wider one.
 */
export type BoundExtension<T extends AnyTarget> = <
  F1 extends AnyFacts = EmptyFacts,
  F2 extends AnyFacts = EmptyFacts,
  F3 extends AnyFacts = EmptyFacts,
  F4 extends AnyFacts = EmptyFacts,
  F5 extends AnyFacts = EmptyFacts,
  F6 extends AnyFacts = EmptyFacts,
  F7 extends AnyFacts = EmptyFacts,
  F8 extends AnyFacts = EmptyFacts,
>(
  name: string,
  p1?: Part<T, F1>,
  p2?: Part<With<T, F1>, F2>,
  p3?: Part<With<With<T, F1>, F2>, F3>,
  p4?: Part<With<With<With<T, F1>, F2>, F3>, F4>,
  p5?: Part<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>,
  p6?: Part<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>,
  p7?: Part<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
  p8?: Part<
    With<With<With<With<With<With<With<T, F1>, F2>, F3>, F4>, F5>, F6>, F7>,
    F8
  >
) => Extension<T, MergeAll<F1, F2, F3, F4, F5, F6, F7, F8>>;

export type ExtensionFunction<Bound extends AnyTarget | undefined> =
  Bound extends AnyTarget ? BoundExtension<Bound> : FreeExtension;

// =============================================================================
// target(...): the models and operations a call concerns
// =============================================================================

declare const operationSet: unique symbol;

/** A named set of operations: `reads`, `writes`, `deletes`, `selecting`, `models`. */
export interface OperationSet<out O extends Operations> {
  readonly [operationSet]: O;
}

declare const selection: unique symbol;

/**
 * What `target(...)` returns: typed against the target like a part, so a
 * misspelt model is refused on the string.
 */
export interface Selection<in T extends AnyTarget, out M, out O> {
  readonly [selection]: (target: T) => readonly [M, O];
}

export interface TargetFunction<Bound extends AnyTarget | undefined> {
  /** Every model, these operations. */
  <T extends Within<Bound>, O extends Operations>(
    operations: OperationSet<O>
  ): Selection<T, ModelName<T>, O>;
  /** One model (or several), these operations (every one when absent). */
  <
    T extends Within<Bound>,
    const M extends ModelName<T> = ModelName<T>,
    const O extends Operations = Operations,
  >(
    models: M | readonly M[],
    operations?: O | readonly O[] | OperationSet<O>
  ): Selection<T, M, O>;
}

// =============================================================================
// call(fn, target?) and around(fn, target?, options?)
// =============================================================================

type IsUnion<U, All = U> = [U] extends [never]
  ? false
  : U extends unknown
    ? [Exclude<All, U>] extends [never]
      ? false
      : true
    : never;

export type PayloadOf<T extends AnyTarget, M, O extends Operations> = Extract<
  Exclude<OperationPayload<O, ModelOf<T, M>>, undefined>,
  object
>;

/**
 * The eighth fact applied: a default omission joins the client's, per model
 * (two parts that omit are merged). A gate's field joins it as a `boolean`.
 */
export type ConfiguredBy<C extends VibORMConfig, F extends AnyFacts> = [
  keyof F["omit"],
] extends [never]
  ? C
  : Omit<C, "omit"> & {
      readonly omit: MergeObjects<
        C extends { readonly omit: infer Earlier extends object }
          ? Earlier
          : NoFields,
        F["omit"]
      >;
    };

type ClientRowsOf<T extends AnyTarget> = ClientRowsContext<
  ConfiguredBy<T["config"], T["own"]>,
  T["state"]["rows"] | T["own"]["rows"]
>;

/**
 * One operation's result on the client the part is applied to, with what
 * the earlier parts of its own extension change in it (rows a rule hides, a
 * default omission): those apply to the call it wraps.
 */
export type CallResult<
  T extends AnyTarget,
  M,
  O extends Operations,
  A,
> = ContextualOperationResult<
  ConfiguredBy<T["config"], T["own"]>,
  M & keyof SchemaOf<T>,
  O,
  A,
  ClientRowsOf<T>
>;

/** Run the prepared call. */
export interface Run<A, R> {
  (): Promise<R>;
  /** The arguments as validated, detached. */
  readonly input: Readonly<A>;
  readonly mode: "direct" | "transaction" | "array";
}

/** Moment 1 of a call naming one model and one operation. */
export interface CallContext<
  in out T extends AnyTarget,
  in out M,
  in out O extends Operations,
> {
  readonly kind: "model";
  /** The schema the extension is applied to. */
  readonly schema: SchemaOf<T>;
  readonly model: M;
  readonly operation: O;
  /** The call's arguments, as the earlier first moments left them: read only. */
  readonly args: Readonly<PayloadOf<T, M, O>>;
  /** This extension's own arguments, as the call passed them. */
  readonly values: OwnValues<T>;
  /** Patch the arguments; a key that decides the result type is refused. */
  set(patch: RequestTransformPatch<O, PayloadOf<T, M, O>>): void;
}

/** Moment 2 of a call naming one (model, operation): around the prepared call. */
export type Around<T extends AnyTarget, M, O extends Operations> = <
  A extends PayloadOf<T, M, O>,
>(
  run: Run<A, CallResult<T, M, O, A>>
) => Promise<CallResult<T, M, O, A>>;

/** Moment 1 of a call over several operations, models, or raw statements. */
export interface GenericCallContext<T extends AnyTarget, M, O> {
  readonly kind: "model" | "raw";
  /** The schema the extension is applied to. */
  readonly schema: SchemaOf<T>;
  readonly model: M | undefined;
  readonly operation:
    | O
    | "$queryRaw"
    | "$executeRaw"
    | "$queryRawUnsafe"
    | "$executeRawUnsafe";
  readonly args: Readonly<Record<string, unknown>>;
  readonly values: OwnValues<T>;
  set(
    patch: Readonly<RequestTransformPatch<Operations, Record<string, unknown>>>
  ): void;
}

/** Moment 2 of a generic call: the result is opaque, so only `run()`'s is returned. */
export type GenericAround = <R>(run: Run<unknown, R>) => Promise<R>;

type Single<M, O> =
  IsUnion<M> extends true ? false : IsUnion<O> extends true ? false : true;

export type MomentOne<T extends AnyTarget, M, O> = [M] extends [never]
  ? GenericCallContext<T, ModelName<T>, Operations>
  : Single<M, O> extends true
    ? O extends Operations
      ? CallContext<T, M, O>
      : never
    : GenericCallContext<T, M, O>;

/**
 * Typed by one result only when `target` names one model and one operation;
 * otherwise the second moment's result is opaque (a union of contexts would
 * give the second moment no contextual signature at all, and with
 * `noImplicitAny` off, `run` would silently be `any`).
 */
export type AroundHandler<T extends AnyTarget, M, O> = [M] extends [never]
  ? (
      c: GenericCallContext<T, ModelName<T>, Operations>
    ) => GenericAround | undefined | void
  : Single<M, O> extends true
    ? O extends Operations
      ? (c: CallContext<T, M, O>) => Around<T, M, O> | undefined | void
      : never
    : (c: GenericCallContext<T, M, O>) => GenericAround | undefined | void;

/** A call typed against one result consumes it (the order rule). */
export type AroundFacts<M, O> = [M] extends [never]
  ? EmptyFacts
  : Single<M, O> extends true
    ? Facts<
        NoMethods,
        NoMethods,
        NoControls,
        never,
        never,
        NoFields,
        NoFields,
        true
      >
    : EmptyFacts;

/**
 * `call(fn, target?)`: the first moment alone, before validation. It reads
 * no result, so it is never a result consumer. A function returned from it
 * is not refused by the types (any value goes to `void`); the runtime
 * refuses it. `around(fn, target?, { inner })` (a separate export, so a
 * program that only patches carries no second moment): both moments, the
 * second around the prepared call; `inner` places it nearest the core
 * whatever the chain's order.
 */
export type CallFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
  M = never,
  O = never,
>(
  handler: (c: MomentOne<T, M, O>) => void,
  target?: Selection<T, M, O>
) => Part<T, EmptyFacts>;

/** `around(fn, target?, options?)`: both moments of a call. */
export type AroundFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
  M = never,
  O = never,
>(
  handler: AroundHandler<T, M, O>,
  target?: Selection<T, M, O>,
  options?: { readonly inner?: true }
) => Part<T, AroundFacts<M, O>>;

/** What `watch(c, …)` is told of the rows a write call writes. */
export interface Watcher {
  /** Are the rows the call writes to `model` with `kind` to be shown? */
  wants(model: string, kind: WriteKind): boolean;
  /** The rows, once every write of the call is made, its own first. */
  rows(
    model: string,
    kind: WriteKind,
    rows: readonly Readonly<Record<string, unknown>>[],
    nested: boolean
  ): void;
}

/** What `settled(c, fn)` is told: the write is durable, or may be. */
export type Outcome = WriteOutcome;

// =============================================================================
// unit(fn, kinds?, options?)
// =============================================================================

export type UnitKind =
  | "operation"
  | "statement"
  | "batch"
  | "transaction"
  | "savepoint"
  | "connection"
  | "cache";

export interface UnitContext {
  readonly kind: UnitKind;
  readonly model: string | undefined;
  readonly operation: string | undefined;
}

/** How a unit ended: never the application's result. */
export interface UnitOutcome {
  readonly status: "success" | "failure";
  readonly duration: number;
  readonly certainty?: "committed" | "may-have-committed";
}

export type UnitFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
>(
  around: (
    unit: UnitContext,
    next: (sql?: Sql) => Promise<UnitOutcome>
  ) => unknown,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: true }
) => Part<T, EmptyFacts>;

/** What an error may carry. */
export type DisclosureFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
>(policy: {
  readonly sql?: boolean;
  readonly parameters?: boolean;
}) => Part<T, EmptyFacts>;

// =============================================================================
// WORDS: values inside a rule
// =============================================================================

declare const argName: unique symbol;
declare const nowWord: unique symbol;
declare const rowWord: unique symbol;
declare const whenWord: unique symbol;
declare const existsWord: unique symbol;
declare const providedWord: unique symbol;

/** `arg("tenant")`: the value the call passed for one argument. */
export interface ArgWord<out N extends string> {
  readonly [argName]: N;
}

declare const heldArg: unique symbol;

/**
 * `arg(name)` written away from a rule (a shared `const`, a per-model
 * callback): its name is no longer typed by the rule's arguments, so it is
 * checked where the extension is applied (an undeclared one is refused).
 */
export interface HeldArg {
  readonly [heldArg]: true;
}

/** `now`: the call's one instant. */
export interface NowWord {
  readonly [nowWord]: true;
}

/** `row("orgId", 1)`: a column of an enclosing row. */
export interface RowWord {
  readonly [rowWord]: true;
}

/** `when(arg("deleted"), "only", where)`: a filter taken only on one value. */
export interface WhenWord<out N extends string, out W> {
  readonly [whenWord]: readonly [N, W];
}

/** `provided(arg("actor"), { exists: true }, where)`: true only where the test holds. */
export interface ProvidedWord<out N extends string> {
  readonly [providedWord]: N;
}

/** `exists({ post: where })`: one row of a model holds the `where`. */
export interface ExistsWord {
  readonly [existsWord]: true;
}

type Words<K extends string> = ArgWord<K> | HeldArg | NowWord | RowWord;

/** A test a `when`, `unless` or `provided` makes of an argument's value. */
export type ArgTest =
  | string
  | number
  | boolean
  | { readonly exists: boolean }
  | { readonly in: readonly (string | number | boolean)[] }
  | { readonly equals: string | number | boolean }
  | { readonly has: string | number | boolean }
  | { readonly hasSome: readonly (string | number | boolean)[] };

// =============================================================================
// rule({ model: { read, root, related, create, update, delete, … } })
// =============================================================================

type WhereOf<M> =
  M extends Model<any>
    ? NonNullable<PayloadOfModel<"findMany", M>["where"]>
    : never;
type PayloadOfModel<O extends Operations, M extends Model<any>> = Extract<
  Exclude<OperationPayload<O, M>, undefined>,
  object
>;

export type ScalarKeysOf<M> =
  M extends Model<infer State>
    ? Extract<keyof State["scalars"], string>
    : never;

/**
 * A field's filter with the words accepted where a value is: the field
 * itself, and each operator one level down (`{ lt: now }`). Deeper than
 * that (a relation's nested `where`), the ORM's own type applies. The
 * operators are named, not read with `keyof` from the filter type: on these
 * validation-inferred filters `keyof` reads `never`, and a mapped type over
 * no key is `{}`, which a number satisfies.
 */
type FilterOperator =
  | "equals"
  | "not"
  | "in"
  | "notIn"
  | "lt"
  | "lte"
  | "gt"
  | "gte"
  | "contains"
  | "startsWith"
  | "endsWith"
  | "has"
  | "hasSome"
  | "hasEvery";

type FilterObjects<V> = Exclude<
  Extract<V, object>,
  readonly unknown[] | Date | FieldRef
>;

type WordValue<V, K extends string> =
  | V
  | Words<K>
  | ([FilterObjects<V>] extends [never]
      ? never
      : {
          readonly [Op in FilterOperator]?:
            | (FilterObjects<V> extends infer Filter
                ? Filter extends unknown
                  ? Op extends keyof Filter
                    ? Filter[Op]
                    : never
                  : never
                : never)
            | Words<K>;
        });

type Connective<M, K extends string> =
  | RuleWhere<M, K>
  | WhenWord<K, RuleWhere<M, K>>
  | WhenWord<string, unknown>
  | ProvidedWord<K>
  | ProvidedWord<string>
  | ExistsWord;

export type RuleWhere<M, K extends string> = {
  readonly [F in keyof WhereOf<M> & string]?: F extends "AND" | "OR" | "NOT"
    ? Connective<M, K> | readonly Connective<M, K>[]
    : WordValue<WhereOf<M>[F], K>;
};

type CreateData<M> =
  M extends Model<any>
    ? Extract<PayloadOfModel<"create", M>["data"], object>
    : never;

/**
 * Keyed by the create data's keys, not by the model's scalar keys: while a
 * literal is typed, the target is still generic, and TypeScript resolves a
 * property of a generic mapped type only when its key set's constraint
 * admits the name (`keyof … & string` does, a conditional does not). The
 * `& string` also keeps the mapped type from being homomorphic, so that
 * TypeScript does not try to infer the client back from the literal (that
 * attempt overflowed: TS2589 on a typo). A relation key reads `never`.
 */
export type ScalarSlots<M, Value> = {
  readonly [F in keyof CreateData<M> & string]?: F extends ScalarKeysOf<M>
    ? Value
    : never;
};

/** A row's values: constants or words, per scalar field. */
export type DataValues<M, K extends string> = {
  readonly [F in keyof CreateData<M> & string]?: F extends ScalarKeysOf<M>
    ? CreateData<M>[F] | Words<K> | { readonly increment: number }
    : never;
};

declare const gateWord: unique symbol;
declare const checkWord: unique symbol;
declare const factsWord: unique symbol;
declare const keepWord: unique symbol;
declare const omittedWord: unique symbol;

/** `gate(where)`: the field is present where the predicate holds. */
export interface GateWord<out W> {
  readonly [gateWord]: W;
}

/** `check(where)`: the row a write leaves must hold the predicate. */
export interface CheckWord<out W> {
  readonly [checkWord]: W;
}

/** `facts({ seen, own })`: per row, which named predicates hold. */
export interface FactsWord<
  out Names extends string,
  out Ordered extends boolean,
> {
  readonly [factsWord]: readonly [Names, Ordered];
}

/** `keep(data)`: the delete updates the row with `data` instead. */
export interface KeepWord<out D> {
  readonly [keepWord]: D;
}

/** `omitted`: the field leaves the default result. */
export interface OmittedWord {
  readonly [omittedWord]: true;
}

type RuleFilter<M, K extends string> =
  | RuleWhere<M, K>
  | WhenWord<K, RuleWhere<M, K>>
  | WhenWord<string, unknown>
  | readonly (
      | RuleWhere<M, K>
      | WhenWord<K, RuleWhere<M, K>>
      | WhenWord<string, unknown>
    )[];

type RelationKeysOf<M> =
  M extends Model<infer State>
    ? Extract<keyof State["relations"], string>
    : never;

/** What binds the caller: filters, checks, gated fields, kept rows. */
export interface RuleEntry<M, K extends string> {
  readonly read?: {
    readonly where?: RuleWhere<M, K>;
    readonly fields?: ScalarSlots<M, GateWord<RuleWhere<M, K>>>;
    readonly select?: {
      readonly [key: `$${string}`]: FactsWord<string, boolean>;
    };
  };
  readonly root?: RuleFilter<M, K>;
  readonly related?: RuleFilter<M, K>;
  readonly create?: { readonly check?: CheckWord<RuleWhere<M, K>> };
  readonly update?: {
    readonly where?: RuleWhere<M, K>;
    readonly check?: CheckWord<RuleWhere<M, K>>;
    readonly fields?: ScalarSlots<
      M,
      {
        readonly where?: RuleWhere<M, K>;
        readonly check?: CheckWord<RuleWhere<M, K>>;
      }
    >;
  };
  readonly delete?: {
    readonly where?: RuleWhere<M, K>;
    readonly instead?: KeepWord<
      DataValues<M, K> | WhenWord<K, DataValues<M, K>>
    >;
  };
  readonly acyclic?:
    | readonly RelationKeysOf<M>[]
    | (() => readonly RelationKeysOf<M>[]);
  readonly confine?: RuleWhere<M, K>;
}

export type RuleInput<T extends AnyTarget> = {
  readonly [M in keyof SchemaOf<T> & string]?:
    | RuleEntry<SchemaOf<T>[M], KnownArgs<T>>
    | (() => RuleEntry<SchemaOf<T>[M], KnownArgs<T>>);
};

/** A model whose rows a call or a relation read can find hidden. */
type HidesRows =
  | { readonly read: { readonly where: object } }
  | { readonly root: unknown }
  | { readonly related: unknown }
  | (() => unknown);

/** The projection facts of one entry, in the form the projected types read. */
type EntryVerbs<E> = (E extends {
  readonly read: {
    readonly select: {
      readonly [K in infer Key extends string]: FactsWord<
        infer Names,
        infer Ordered
      >;
    };
  };
}
  ? {
      readonly evidence: {
        readonly as: Key;
        readonly names: readonly Names[];
        readonly ordered: Ordered;
      };
    }
  : unknown) &
  (E extends { readonly read: { readonly fields: infer Gated } }
    ? { readonly reads: { readonly [F in keyof Gated]: string } }
    : unknown);

type RuleVerbs<R> = {
  readonly [M in keyof R as R[M] extends {
    readonly read: { readonly select: object } | { readonly fields: object };
  }
    ? M
    : never]: EntryVerbs<R[M]>;
};

/** A rule's facts: the models whose rows it can hide (`| null`), its projections. */
export type RuleFacts<R> = Facts<
  NoMethods,
  NoMethods,
  NoControls,
  Extract<
    { [M in keyof R]-?: R[M] extends HidesRows ? M : never }[keyof R],
    string
  >,
  never,
  NoFields,
  NoFields,
  false,
  false,
  RuleVerbs<R>
>;

// =============================================================================
// defaults({ model: { orderBy, create, update, fields } })
// =============================================================================

/** What holds when the caller says nothing, and the caller may override. */
export interface DefaultsEntry<M, K extends string> {
  readonly orderBy?:
    | ScalarSlots<M, "asc" | "desc">
    | readonly ScalarSlots<M, "asc" | "desc">[];
  readonly create?: DataValues<M, K>;
  readonly update?: DataValues<M, K>;
  readonly fields?: ScalarSlots<M, OmittedWord>;
}

export type DefaultsInput<T extends AnyTarget> = {
  readonly [M in keyof SchemaOf<T> & string]?: DefaultsEntry<
    SchemaOf<T>[M],
    KnownArgs<T>
  >;
};

/**
 * Two facts: the fields a default writes on create (optional there, root
 * and nested), and the fields it omits (gone from default results).
 */
export type DefaultsFacts<D> = Facts<
  NoMethods,
  NoMethods,
  NoControls,
  never,
  {
    [M in keyof D]-?: D[M] extends { readonly create: infer Data }
      ? StampedFields<M, keyof Data>
      : never;
  }[keyof D],
  NoFields,
  {
    readonly [M in keyof D as D[M] extends { readonly fields: object }
      ? M
      : never]: D[M] extends { readonly fields: infer Fields }
      ? {
          readonly [F in keyof Fields as Fields[F] extends OmittedWord
            ? F
            : never]: true;
        }
      : never;
  }
>;

/**
 * The keys a literal names that its target type does not have, mapped to
 * `never` at every depth the literal reaches: a typo beside a real key is a
 * compile error at the typo, whether the literal is fresh or held. Words and
 * functions are opaque. A leaf is checked against its slot here too: inside
 * the intersection `R & RuleInput<T>`, TypeScript skips its weak-type check,
 * so `title: 1` would pass against an all-optional operator object.
 */
export type Exact<Given, Allowed> = Given extends
  | ArgWord<string>
  | HeldArg
  | NowWord
  | RowWord
  | WhenWord<string, unknown>
  | ProvidedWord<string>
  | ExistsWord
  | GateWord<unknown>
  | CheckWord<unknown>
  | FactsWord<string, boolean>
  | KeepWord<unknown>
  | OmittedWord
  | ((...args: never[]) => unknown)
  ? Given
  : Given extends readonly (infer Element)[]
    ? readonly Exact<Element, ElementOf<Allowed>>[]
    : Given extends object
      ? {
          readonly [Key in keyof Given]: Key extends KeysOf<ObjectsOf<Allowed>>
            ? Exact<Given[Key], ValueAt<ObjectsOf<Allowed>, Key>>
            : never;
        }
      : Given extends string | number | boolean
        ? [Given] extends [Allowed]
          ? Given
          : never
        : Given;

type ObjectsOf<Allowed> = Exclude<
  Extract<Allowed, object>,
  | readonly unknown[]
  | ArgWord<string>
  | HeldArg
  | NowWord
  | RowWord
  | WhenWord<string, unknown>
  | ProvidedWord<string>
  | ExistsWord
  | GateWord<unknown>
  | CheckWord<unknown>
  | FactsWord<string, boolean>
  | KeepWord<unknown>
  | OmittedWord
  | ((...args: never[]) => unknown)
>;
type KeysOf<Union> = Union extends unknown ? keyof Union : never;
type ValueAt<Union, Key> = Union extends unknown
  ? Key extends keyof Union
    ? Union[Key]
    : never
  : never;
type ElementOf<Allowed> = Allowed extends readonly (infer Element)[]
  ? Element
  : never;

/**
 * `R` has no constraint on purpose: its constraint would be read with `T`
 * unresolved while the literal is typed, and the words inside would lose the
 * argument names. The literal is typed by `RuleInput<T>` beside it instead.
 * The second form reads the schema the extension is applied to: written
 * apart from any client (an official extension that depends on the schema),
 * it is typed by the schema alone.
 */
export interface RuleFunction<Bound extends AnyTarget | undefined> {
  <T extends Within<Bound>, const R = RuleInput<T>>(
    rules: R & RuleInput<T> & NoInfer<Exact<R, RuleInput<T>>>
  ): Part<T, RuleFacts<R>>;
  <T extends Within<Bound>>(
    build: (schema: SchemaOf<T>) => Readonly<Record<string, object>>
  ): Part<T, EmptyFacts>;
}

/** Same shape as `rule`: `D` unconstrained, typed by `DefaultsInput<T>` beside it. */
export interface DefaultsFunction<Bound extends AnyTarget | undefined> {
  <T extends Within<Bound>, const D = DefaultsInput<T>>(
    defaults: D & DefaultsInput<T> & NoInfer<Exact<D, DefaultsInput<T>>>
  ): Part<T, DefaultsFacts<D>>;
  <T extends Within<Bound>>(
    build: (schema: SchemaOf<T>) => Readonly<Record<string, object>>
  ): Part<T, EmptyFacts>;
}

// =============================================================================
// args({ name: declaration })
// =============================================================================

declare const argDeclaration: unique symbol;

/** One declared argument: its value, its operations, whether it is bound. */
export interface ArgDeclaration<
  out Value,
  out O extends Operations = Operations,
  out Bound extends boolean = false,
> {
  readonly [argDeclaration]: readonly [Value, O, Bound];
}

/** An argument with its modifiers: `oneOf(...)`, `accepts(schema)`. */
export interface Accepted<out Value, out O extends Operations = Operations>
  extends ArgDeclaration<Value, O> {
  /** The value a call that passes none reads. */
  default(value: Value): Accepted<Value, O>;
  /** Accepted only on these operations. */
  on<Placed extends Operations>(
    operations: OperationSet<Placed> | Placed | readonly Placed[]
  ): Accepted<Value, Placed>;
  /** Accepted only on these models. */
  models(models: readonly string[]): Accepted<Value, O>;
  /** A call that leaves it out is refused (on these models only, when named). */
  required(models?: readonly string[]): Accepted<Value, O>;
  /** A read that carries it is not served from the cache. */
  volatile(): Accepted<Value, O>;
}

/** `bound(schema)` and its modifiers. */
export interface BoundAccepted<out Value>
  extends ArgDeclaration<Value, never, true> {
  required(models?: readonly string[]): BoundAccepted<Value>;
  volatile(): BoundAccepted<Value>;
}

export type ArgSource =
  | ArgDeclaration<unknown, Operations, boolean>
  | StandardSchemaV1;

type ValueOf<D> =
  D extends ArgDeclaration<infer Value, Operations, boolean>
    ? Value
    : D extends StandardSchemaV1<infer Input>
      ? Input
      : never;

type OperationsOf<D> =
  D extends ArgDeclaration<unknown, infer O, boolean> ? O : Operations;

/**
 * Each argument as the delegates read it. A bound argument is placed on no
 * operation: a call cannot pass it, a rule can name it.
 */
export type ArgsFacts<D> = Facts<
  NoMethods,
  NoMethods,
  {
    readonly [Name in keyof D]: PlacedControl<
      ValueOf<D[Name]>,
      PropertyKey,
      OperationsOf<D[Name]>
    >;
  }
>;

export type ArgsFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
  const D extends Readonly<Record<string, ArgSource>> = Readonly<
    Record<string, ArgSource>
  >,
>(
  declarations: D
) => Part<T, ArgsFacts<D>>;

// =============================================================================
// methods((scope) => ({ $client: …, model: { … } }))
// =============================================================================

type ClientKeys<R> = Extract<keyof R, `$${string}`>;

/**
 * A factory that takes the typed scope reads the client's types at this
 * step: it is a result consumer. One that takes nothing reads nothing typed,
 * and types its methods' results from their delegate through a `this`
 * parameter.
 */
export type MethodsFacts<R, Consumer extends boolean> = Facts<
  { readonly [Key in ClientKeys<R>]: R[Key] },
  {
    readonly [M in Exclude<keyof R, ClientKeys<R>>]: R[M];
  },
  NoControls,
  never,
  never,
  NoFields,
  NoFields,
  Consumer
>;

export type MethodsScope<T extends AnyTarget> = ExtensionClientScope<
  T["config"],
  T["state"]
>;

/** A returned key that is neither a `$` client method nor a model. */
export type UnknownMethodKeys<R, T extends AnyTarget> = {
  readonly [Key in Exclude<keyof R, ModelName<T> | `$${string}`>]: never;
};

/**
 * The factory's own type is inferred (`F`) and checked against itself
 * (F-bounded). The returned object must not get a function-typed contextual
 * type: TypeScript would instantiate a generic method such as
 * `restore<Self>(this: Self, …)` at once, and `Self` would be lost.
 */
export type MethodsFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
  F extends (scope: MethodsScope<T>) => UnknownMethodKeys<ReturnType<F>, T> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
) => Part<
  T,
  MethodsFacts<ReturnType<F>, Parameters<F> extends readonly [] ? false : true>
>;

// =============================================================================
// fields({ model: { name: { needs, compute } } })
// =============================================================================

export type FieldsFunction<Bound extends AnyTarget | undefined> = <
  T extends Within<Bound>,
  const Declared extends object = object,
  Needs = unknown,
>(
  fields: Declared &
    NonNullable<
      ResultInference<T["config"], T["state"]["result"], Needs>["result"]
    >
) => Part<
  T,
  Facts<
    NoMethods,
    NoMethods,
    NoControls,
    never,
    never,
    DefinitionResultFields<{ readonly result: Declared }>
  >
>;

// =============================================================================
// parts<Of>(): the vocabulary bound to one target
// =============================================================================

export interface Parts<T extends AnyTarget> {
  readonly extension: ExtensionFunction<T>;
  readonly call: CallFunction<T>;
  readonly around: AroundFunction<T>;
  readonly target: TargetFunction<T>;
  readonly unit: UnitFunction<T>;
  readonly rule: RuleFunction<T>;
  readonly defaults: DefaultsFunction<T>;
  readonly disclosure: DisclosureFunction<T>;
  readonly args: ArgsFunction<T>;
  readonly methods: MethodsFunction<T>;
  readonly fields: FieldsFunction<T>;
}

/**
 * The target `parts<Of>()` binds: a client type gives its config and its
 * extension state; a schema gives the config `createClient` builds over it
 * (the linked snapshot: a plain `VibORMConfig<S>` is not a supertype of a
 * client's config, whose relation getters are erased) and ANY extension
 * state, since an extension written apart from a client cannot know the
 * chain it will follow.
 */
export type TargetOf<Of> =
  Of extends ClientTypeState<infer C, infer X>
    ? Target<C, X, EmptyFacts>
    : Of extends VibORMConfig["schema"]
      ? Target<
          LinkedClientConfig<VibORMConfig<Of>>,
          ExtensionStateConstraint,
          EmptyFacts
        >
      : never;

/** The operation sets `on`, `.on(...)` and `.required(...)` take. */
export type ReadOperations = CacheableOperations;
export type WriteOperations = MutationOperations;
export type DeleteOperations = "delete" | "deleteMany";
export type SelectingOperations = Exclude<Operations, "create" | "createMany">;
