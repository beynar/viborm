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

import type {
  ClientTypeState,
  LinkedConfigOf,
  VibORMClientMembers,
  VibORMConfig,
} from "@client/client";
import type { RawSurface } from "@client/raw";
import type { ClientSchema, LinkedClientConfig } from "@client/schema-links";
import type {
  ClientRowsContext,
  ContextualOperationResult,
  OperationPayload,
  Operations,
} from "@client/types";
import type { FieldRef } from "@schema/field-ref";
import type { Model } from "@schema/model";
import type { Sql } from "@sql";
import type {
  ExtensionClientScope,
  ExtensionStateConstraint,
  MergeModelMethods,
} from "./methods";
import type { WriteOutcome } from "./query";
import type { RequestTransformPatch } from "./request";
import type {
  ComputedFieldTypes,
  FieldsInference,
  MergeResultFields,
} from "./result-types";
import type { WriteKind } from "./written";

type NoMethods = Record<never, never>;
type NoFields = Record<never, never>;

// =============================================================================
// ARGUMENT AND DATA FACTS: what `args` and `defaults` add to the delegates
// =============================================================================

/**
 * One declared argument as the delegates read it: its value, the models and
 * the operations that accept it.
 */
export interface PlacedArgument<
  Value = unknown,
  Models = PropertyKey,
  Placed = Operations,
> {
  readonly value: Value;
  readonly models: Models;
  readonly operations: Placed;
}

export type NoArguments = Record<never, never>;

/** The optional arguments one (model, operation) accepts. */
export type OperationArguments<Arguments, ModelName, Operation> = {
  readonly [Name in keyof Arguments as Arguments[Name] extends PlacedArgument<
    unknown,
    infer Models,
    infer Placed
  >
    ? ModelName extends Models
      ? Operation extends Placed
        ? Name
        : never
      : never
    : never]?: Arguments[Name] extends PlacedArgument<infer Value>
    ? Value
    : never;
};

/**
 * The fields one `defaults` entry writes on its models' creates: there they
 * may be left out even where the schema requires them. An update's fields
 * need nothing, as every field of an update is optional already.
 */
export interface StampedFields<Models = PropertyKey, Fields = PropertyKey> {
  readonly models: Models;
  readonly fields: Fields;
}

/** The fields a chain writes on every create of one model. */
export type StampedFieldNames<Data, ModelName> =
  Data extends StampedFields<infer Models, infer Fields extends PropertyKey>
    ? ModelName extends Models
      ? Fields
      : never
    : never;

// =============================================================================
// FACTS: what one part contributes to the client's extension state
// =============================================================================

/**
 * The facts a part can contribute: the members of `ClientExtensionState` a
 * chain accumulates, `omit` (the fields a default leaves out, which joins the
 * client's own omission), `consumer` (the part was typed against a result,
 * so a later rule that hides rows would make its type lie) and `projected`
 * (what a rule's `gate` and `facts` add to the delegates, in the form the
 * projected types read).
 */
export interface Facts<
  Client extends object = NoMethods,
  Models extends object = NoMethods,
  Arguments extends object = NoArguments,
  Filtered extends string = never,
  Defaults = never,
  Fields extends object = NoFields,
  Omit extends object = NoFields,
  Consumer extends boolean = false,
  Projected extends object = NoFields,
> {
  readonly client: Client;
  readonly models: Models;
  readonly args: Arguments;
  readonly filtered: Filtered;
  readonly defaults: Defaults;
  readonly fields: Fields;
  readonly omit: Omit;
  readonly consumer: Consumer;
  readonly projected: Projected;
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
type MergeFacts<Left extends AnyFacts, Right extends AnyFacts> = Facts<
  Left["client"] & Right["client"],
  MergeModelMethods<Left["models"], Right["models"]>,
  Left["args"] & Right["args"],
  Left["filtered"] | Right["filtered"],
  Left["defaults"] | Right["defaults"],
  MergeResultFields<Left["fields"], Right["fields"]>,
  MergeObjects<Left["omit"], Right["omit"]>,
  Left["consumer"] extends true
    ? true
    : Right["consumer"] extends true
      ? true
      : false,
  MergeObjects<Left["projected"], Right["projected"]>
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
 * What a part bound to a target is typed against: that client, whatever the
 * earlier parts of its extension declared (it may follow any of them).
 */
export type Within<T extends AnyTarget> = Target<
  T["config"],
  T["state"],
  AnyFacts
>;

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

type SchemaOf<T extends AnyTarget> = ClientSchema<T["config"]>;
type ModelOf<T extends AnyTarget, M> = SchemaOf<T>[M & keyof SchemaOf<T>];
export type ModelName<T extends AnyTarget> = keyof SchemaOf<T> & string;

/** Every argument name a rule or a call of this part may read. */
type KnownArgs<T extends AnyTarget> = Extract<
  keyof T["state"]["args"] | keyof T["own"]["args"],
  string
>;

/** The values a call receives for its own extension's arguments. */
type OwnValues<T extends AnyTarget> = {
  readonly [Name in keyof T["own"]["args"]]?: T["own"]["args"][Name] extends PlacedArgument<
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
 * The same with the target fixed (`parts<Of>()`): not generic in it, so its
 * parts are checked against the bound client, never an inferred wider one.
 */
type BoundExtension<T extends AnyTarget> = <
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

interface TargetFunction<T extends AnyTarget> {
  /** Every model, these operations. */
  <O extends Operations>(
    operations: OperationSet<O>
  ): Selection<T, ModelName<T>, O>;
  /** One model (or several), these operations (every one when absent). */
  <
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
  T["state"]["filtered"] | T["own"]["filtered"]
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

/**
 * Moment 2 of a call naming one (model, operation): around the prepared
 * call. It returns what `run()` returned, or, for a read it answers in place
 * of the core (a cache), a result of the operation's default shape: an
 * answer built by hand cannot be typed by the call's own arguments, which
 * are generic here. A partial row is still refused.
 */
export type Around<T extends AnyTarget, M, O extends Operations> = <
  A extends PayloadOf<T, M, O>,
>(
  run: Run<A, CallResult<T, M, O, A>>
) => Promise<CallResult<T, M, O, A> | CallResult<T, M, O, NoArguments>>;

/** Moment 1 of a model call over several operations or models. */
interface ModelCallContext<T extends AnyTarget, M, O> {
  readonly kind: "model";
  /** The schema the extension is applied to. */
  readonly schema: SchemaOf<T>;
  readonly model: M;
  readonly operation: O;
  readonly args: Readonly<Record<string, unknown>>;
  readonly values: OwnValues<T>;
  set(
    patch: Readonly<RequestTransformPatch<Operations, Record<string, unknown>>>
  ): void;
}

/**
 * Moment 1 of a raw statement, which a call or an `around` without a target
 * sees. It has no model and no arguments to set.
 */
interface RawCallContext<T extends AnyTarget> {
  readonly kind: "raw";
  readonly schema: SchemaOf<T>;
  readonly model: undefined;
  readonly operation:
    | "$queryRaw"
    | "$executeRaw"
    | "$queryRawUnsafe"
    | "$executeRawUnsafe";
  readonly args: Readonly<Record<string, unknown>>;
  readonly values: OwnValues<T>;
}

/** Moment 1 of a call over several operations, models, or raw statements: `kind` tells them apart. */
export type AnyCallContext<T extends AnyTarget, M, O> =
  | ModelCallContext<T, M, O>
  | RawCallContext<T>;

/** Moment 2 of a generic call: the result is opaque, so only `run()`'s is returned. */
type AnyAround = <R>(run: Run<unknown, R>) => Promise<R>;

type Single<M, O> =
  IsUnion<M> extends true ? false : IsUnion<O> extends true ? false : true;

/**
 * Without a target, a call also sees raw statements (spec 3), told apart by
 * `kind`; a target names model operations only.
 */
export type MomentOne<T extends AnyTarget, M, O> = [M] extends [never]
  ? AnyCallContext<T, ModelName<T>, Operations>
  : Single<M, O> extends true
    ? O extends Operations
      ? CallContext<T, M, O>
      : never
    : ModelCallContext<T, M, O>;

/**
 * Typed by one result only when `target` names one model and one operation;
 * otherwise the second moment's result is opaque (a union of contexts would
 * give the second moment no contextual signature at all, and with
 * `noImplicitAny` off, `run` would silently be `any`). Without a target, it
 * also sees raw statements.
 */
export type AroundHandler<T extends AnyTarget, M, O> = [M] extends [never]
  ? (
      c: AnyCallContext<T, ModelName<T>, Operations>
    ) => AnyAround | undefined | void
  : Single<M, O> extends true
    ? O extends Operations
      ? (c: CallContext<T, M, O>) => Around<T, M, O> | undefined | void
      : never
    : (c: ModelCallContext<T, M, O>) => AnyAround | undefined | void;

/** A call typed against one result consumes it (the order rule). */
export type AroundFacts<M, O> = [M] extends [never]
  ? EmptyFacts
  : Single<M, O> extends true
    ? Facts<
        NoMethods,
        NoMethods,
        NoArguments,
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
type CallFunction<T extends AnyTarget> = <M = never, O = never>(
  handler: (c: MomentOne<T, M, O>) => void,
  target?: Selection<T, M, O>
) => Part<T, EmptyFacts>;

/** `around(fn, target?, options?)`: both moments of a call. */
type AroundFunction<T extends AnyTarget> = <M = never, O = never>(
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

/**
 * The kinds the core emits, and any an extension emits of its own (`work`):
 * an open string.
 */
export type UnitKind =
  | "operation"
  | "statement"
  | "batch"
  | "transaction"
  | "savepoint"
  | "connection"
  | (string & {});

export interface UnitContext {
  readonly kind: UnitKind;
  readonly model: string | undefined;
  readonly operation: string | undefined;
}

declare const rewritten: unique symbol;

/**
 * The unit a part declared `{ rewrites: true }` is handed: a statement about
 * to be sent. A rewrite never sees a verbatim unsafe raw statement, so its
 * `statement(u)` is always there.
 */
export interface StatementUnit extends UnitContext {
  readonly kind: "statement";
  readonly [rewritten]: true;
}

/** The unit a part's handler is handed: a statement one when it rewrites. */
export type UnitOf<Rewrites extends true | undefined> = Rewrites extends true
  ? StatementUnit
  : UnitContext;

/**
 * How a unit's child ended, as `next()` resolves it: never the application's
 * result; the failure itself is read by `failure(unit)`.
 */
export interface UnitOutcome {
  readonly status: "success" | "failure";
  /** Milliseconds from `next()` to the child's settlement. */
  readonly duration: number;
  /** Present where the child's work reached a commit. */
  readonly certainty?: "committed" | "may-have-committed";
  /**
   * The child failed and its owner recovered (a `findUnique` batch's shared
   * read, whose callers each ran alone): the failure is not the call's.
   */
  readonly recovered?: true;
}

type UnitFunction<T extends AnyTarget> = <
  Rewrites extends true | undefined = undefined,
>(
  around: (
    unit: UnitOf<Rewrites>,
    next: (sql?: Sql) => Promise<UnitOutcome>
  ) => unknown,
  kinds?: readonly UnitKind[],
  options?: { readonly rewrites?: Rewrites }
) => Part<T, EmptyFacts>;

/** What an error may carry. */
type DisclosureFunction<T extends AnyTarget> = (policy: {
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

/**
 * Whether a word's operand type was read from no rule: `unknown` (written
 * apart from any rule), or `never` (typed by another held word, as in an
 * array of them). Such a word is held: any operand, refused or admitted by
 * the rule's model where the extension is applied (spec 13, correction 5).
 */
export type IsHeld<W> = unknown extends W
  ? true
  : [W] extends [never]
    ? true
    : false;

/**
 * A word's operand: the filter its rule's place expects, anything when held.
 * The filter stays the union's first member, never inside a conditional: a
 * word written inside the operand (`{ ownerId: arg("user") }`) is typed by
 * it while `W` is still being inferred.
 */
export type HeldOperand<W> = NoInfer<W> | HeldOnly<W>;

/** What only a held word takes beside its filter: anything. */
type HeldOnly<W> = IsHeld<W> extends true ? unknown : never;

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

/** The operator words of a field's filter: `{ lt: now }`. */
type OperatorWords<V, K extends string> = [FilterObjects<V>] extends [never]
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
    };

/** A relation's filter operators: their operands are the target's `where`. */
type RelationOperator = "is" | "isNot" | "some" | "every" | "none";

/** The target's `where` under one relation operator of a field's filter. */
type TargetWhere<V, Op> =
  FilterObjects<V> extends infer Filter
    ? Filter extends unknown
      ? Op extends keyof Filter
        ? Extract<NonNullable<Filter[Op]>, object>
        : never
      : never
    : never;

/** A to-one filter written as the target's `where` itself (`org: { name }`). */
type DirectWhere<V> =
  FilterObjects<V> extends infer Filter
    ? Filter extends unknown
      ? "AND" extends keyof Filter
        ? Filter
        : never
      : never
    : never;

/** How many relations deep a rule's words reach; deeper, the ORM's own type. */
type Deeper = [0, 0, 1, 2];

/**
 * A relation's filter with the words accepted in the target's `where`, under
 * `is`, `isNot`, `some`, `every`, `none` or written directly on a to-one
 * (`org: { members: { some: { userId: arg("user") } } }`). Bounded in depth,
 * so a recursive model ends.
 */
type RelationWords<V, K extends string, Depth extends number> = Depth extends 0
  ? never
  : [TargetWhere<V, RelationOperator> | DirectWhere<V>] extends [never]
    ? never
    :
        | {
            readonly [Op in RelationOperator]?: TargetWords<
              TargetWhere<V, Op>,
              K,
              Deeper[Depth]
            >;
          }
        | TargetWords<DirectWhere<V>, K, Deeper[Depth]>;

type TargetWords<W, K extends string, Depth extends number> = [W] extends [
  never,
]
  ? never
  : {
      // A connective under a relation takes the same words as its target's
      // fields (`folder: { is: { OR: [{ ownerId: arg("user") }, …] } }`).
      readonly [F in keyof W & string]?: F extends "AND" | "OR" | "NOT"
        ? TargetWords<W, K, Depth> | readonly TargetWords<W, K, Depth>[]
        : WordValue<W[F], K, Depth>;
    };

type WordValue<V, K extends string, Depth extends number = 3> =
  | V
  | Words<K>
  | OperatorWords<V, K>
  | RelationWords<V, K, Depth>;

/**
 * The model of a target whose models are unknown (`Model<any>`): a part
 * written apart from any client, typed under one literal model name. Its
 * filters and values are open, checked where the extension is applied.
 */
type IsOpenModel<M> =
  M extends Model<infer State> ? (0 extends 1 & State ? true : false) : false;

/** A condition: a filter, or a word that holds or not for a row. */
type RuleCondition<M, K extends string> =
  | RuleWhere<M, K>
  | ProvidedWord<K>
  | ExistsWord;

type Connective<M, K extends string> =
  | RuleCondition<M, K>
  | WhenWord<K, RuleCondition<M, K>>;

type RuleWhere<in out M, in out K extends string> = {
  readonly [F in keyof WhereOf<M> & string]?: IsOpenModel<M> extends true
    ? unknown
    : F extends "AND" | "OR" | "NOT"
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
type ScalarSlots<in out M, in out Value> = {
  readonly [F in keyof CreateData<M> & string]?: F extends ScalarKeysOf<M>
    ? Value
    : never;
};

/** A row's values: constants or words, per scalar field. */
type DataValues<in out M, in out K extends string> = {
  readonly [F in keyof CreateData<M> & string]?: IsOpenModel<M> extends true
    ? unknown
    : F extends ScalarKeysOf<M>
      ? CreateData<M>[F] | Words<K> | { readonly increment: number }
      : never;
};

declare const gateWord: unique symbol;
declare const checkWord: unique symbol;
declare const factsWord: unique symbol;
declare const keepWord: unique symbol;
declare const onlyWord: unique symbol;
declare const lazyWord: unique symbol;
declare const omittedWord: unique symbol;
declare const confineWord: unique symbol;

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

/** `only(where)`: a write takes only the rows that hold the predicate. */
export interface OnlyWord<out W> {
  readonly [onlyWord]: W;
}

/** `within(where)`: every row of a set computed over the whole table holds it. */
export interface ConfineWord<out W> {
  readonly [confineWord]: W;
}

/** `lazy(() => entry)`: the entry is read when its model is first read. */
export interface LazyWord<out E> {
  readonly [lazyWord]: E;
}

/** `omitted`: the field leaves the default result. */
export interface OmittedWord {
  readonly [omittedWord]: true;
}

type RuleFilter<M, K extends string> =
  | RuleWhere<M, K>
  | WhenWord<K, RuleCondition<M, K>>
  | readonly (RuleWhere<M, K> | WhenWord<K, RuleCondition<M, K>>)[];

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
    readonly where?: OnlyWord<RuleWhere<M, K>>;
    readonly check?: CheckWord<RuleWhere<M, K>>;
    readonly fields?: ScalarSlots<
      M,
      {
        readonly where?: OnlyWord<RuleWhere<M, K>>;
        readonly check?: CheckWord<RuleWhere<M, K>>;
      }
    >;
  };
  readonly delete?: {
    readonly where?: OnlyWord<RuleWhere<M, K>>;
    readonly instead?: KeepWord<
      DataValues<M, K> | WhenWord<K, DataValues<M, K>>
    >;
  };
  readonly acyclic?:
    | readonly RelationKeysOf<M>[]
    | (() => readonly RelationKeysOf<M>[]);
  readonly confine?: ConfineWord<RuleWhere<M, K>>;
}

/**
 * An entry written apart from any client (`AnyTarget`, whose model names are
 * `string`): its models are unknown, so its leaves are any filter, any value
 * and any word, checked where the extension is applied, as the runtime
 * checks every rule. Without it, a rule written in a function of model names
 * (a recipe) types every leaf against `Model<any>` and overflows (TS2589).
 */
interface WideRuleEntry {
  readonly read?: {
    readonly where?: object;
    readonly fields?: Readonly<Record<string, GateWord<unknown>>>;
    readonly select?: {
      readonly [key: `$${string}`]: FactsWord<string, boolean>;
    };
  };
  readonly root?: object;
  readonly related?: object;
  readonly create?: { readonly check?: CheckWord<unknown> };
  readonly update?: {
    readonly where?: OnlyWord<unknown>;
    readonly check?: CheckWord<unknown>;
    readonly fields?: Readonly<
      Record<
        string,
        {
          readonly where?: OnlyWord<unknown>;
          readonly check?: CheckWord<unknown>;
        }
      >
    >;
  };
  readonly delete?: {
    readonly where?: OnlyWord<unknown>;
    readonly instead?: KeepWord<unknown>;
  };
  readonly acyclic?: readonly string[] | (() => readonly string[]);
  readonly confine?: ConfineWord<unknown>;
}

/**
 * The key decides between the two: a model's literal name reads its fields;
 * `string`, the key of a target whose models are unknown, reads none. The
 * test is on the key, never on `T`: while a literal is typed `T` is still
 * generic, and only the key is known at the property being typed.
 */
export type RuleInput<T extends AnyTarget> = {
  readonly [M in keyof SchemaOf<T> & string]?: string extends M
    ? WideRuleEntry | LazyWord<WideRuleEntry>
    :
        | RuleEntry<SchemaOf<T>[M], KnownArgs<T>>
        | LazyWord<RuleEntry<SchemaOf<T>[M], KnownArgs<T>>>;
};

/** A model whose rows a call or a relation read can find hidden. */
type HidesRows =
  | { readonly read: { readonly where: object } }
  | { readonly root: unknown }
  | { readonly related: unknown }
  | LazyWord<unknown>;

/** The projection facts of one entry, in the form the projected types read. */
type EntryProjection<E> = (E extends {
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

/** An entry as written, or as the function of a lazy entry returns it. */
type EntryOf<E> = E extends () => infer Returned ? Returned : E;

type RuleProjections<R, Names extends string> = {
  readonly [M in keyof R as M extends Names
    ? EntryOf<R[M]> extends {
        readonly read:
          | { readonly select: object }
          | { readonly fields: object };
      }
      ? M
      : never
    : never]: EntryProjection<EntryOf<R[M]>>;
};

/**
 * A rule's facts: the models whose rows it can hide (`| null`), its
 * projections. Only models of the target (`Names`) count: one it does not
 * have is refused at its key already, and `$extends` would refuse it again.
 */
export type RuleFacts<R, Names extends string = string> = EntryFacts<
  Entries<R>,
  Names
>;

/** A rule's entries: given as they are, or as a function of the schema returns them. */
type Entries<R> = R extends (...args: never[]) => infer Returned ? Returned : R;

/**
 * A rule's facts from its entries. Entries keyed by any string (a function
 * of the schema that builds every model's) can hide every model's rows.
 */
type EntryFacts<R, Names extends string> = Facts<
  NoMethods,
  NoMethods,
  NoArguments,
  string extends keyof R
    ? string
    : Extract<
        { [M in keyof R]-?: R[M] extends HidesRows ? M : never }[keyof R],
        Names
      >,
  never,
  NoFields,
  NoFields,
  false,
  RuleProjections<R, Names>
>;

/**
 * A rule or a default read from the schema where the extension is applied:
 * `rule((schema) => entries)`, the form of an extension that depends on the
 * schema (`permissions`). Its returned entries are typed by the same input.
 */
export type FromSchema<T extends AnyTarget, Input> = (
  schema: SchemaOf<T>
) => Input;

// =============================================================================
// defaults({ model: { orderBy, create, update, fields } })
// =============================================================================

/** What holds when the caller says nothing, and the caller may override. */
interface DefaultsEntry<M, K extends string> {
  readonly orderBy?:
    | ScalarSlots<M, "asc" | "desc">
    | readonly ScalarSlots<M, "asc" | "desc">[];
  readonly create?: DataValues<M, K>;
  readonly update?: DataValues<M, K>;
  readonly fields?: ScalarSlots<M, OmittedWord>;
}

/** `defaults` written apart from any client: see `WideRuleEntry`. */
interface WideDefaultsEntry {
  readonly orderBy?:
    | Readonly<Record<string, "asc" | "desc">>
    | readonly Readonly<Record<string, "asc" | "desc">>[];
  readonly create?: Readonly<Record<string, unknown>>;
  readonly update?: Readonly<Record<string, unknown>>;
  readonly fields?: Readonly<Record<string, OmittedWord>>;
}

export type DefaultsInput<T extends AnyTarget> = {
  readonly [M in keyof SchemaOf<T> & string]?: string extends M
    ? WideDefaultsEntry
    : DefaultsEntry<SchemaOf<T>[M], KnownArgs<T>>;
};

/**
 * Two facts: the fields a default writes on create (optional there, root
 * and nested), and the fields it omits (gone from default results). Only
 * models of the target (`Names`) count, as in `RuleFacts`.
 */
export type DefaultsFacts<D, Names extends string = string> = DefaultFacts<
  Entries<D>,
  Names
>;

type DefaultFacts<D, Names extends string> = [D] extends [never]
  ? // A refused literal (or one cast to `never`) contributes nothing.
    EmptyFacts
  : Facts<
      NoMethods,
      NoMethods,
      NoArguments,
      never,
      {
        [M in keyof D]-?: M extends Names
          ? D[M] extends { readonly create: infer Data }
            ? StampedFields<M, keyof Data>
            : never
          : never;
      }[keyof D],
      NoFields,
      {
        readonly [M in keyof D as M extends Names
          ? D[M] extends { readonly fields: object }
            ? M
            : never
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
export type Exact<Given, Allowed> = string extends keyof Allowed
  ? // A map keyed by any string (a part written apart from any client) has
    // no typo to refuse. Decided on `Allowed` alone, so that a literal built
    // in a generic function (a recipe's map over its model names) is never
    // deferred.
    Given
  : Given extends
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
        | OnlyWord<unknown>
        | LazyWord<unknown>
        | OmittedWord
        | ((...args: never[]) => unknown)
    ? Given
    : Given extends readonly (infer Element)[]
      ? readonly Exact<Element, ElementOf<Allowed>>[]
      : Given extends object
        ? {
            readonly [Key in keyof Given]: Key extends KeysOf<
              ObjectsOf<Allowed>
            >
              ? Exact<Given[Key], ValueAt<ObjectsOf<Allowed>, Key>>
              : never;
          }
        : Given extends string | number | boolean
          ? [Given] extends [Allowed]
            ? Given
            : never
          : Given;

/**
 * `Exact` of a rule's or a default's entries, given as they are or as a
 * function of the schema returns them: the returned literal is refused key
 * by key too, as an inline one is.
 */
export type ExactEntries<Given, Allowed> = string extends keyof Allowed
  ? // Written apart from any client: decided on `Allowed` alone, never
    // deferred on a recipe's generic map (see `Exact`).
    Given
  : Given extends (...args: infer Parameters) => infer Returned
    ? string extends keyof Returned
      ? // Entries built for every model at once: their names are the
        // runtime's to check.
        Given
      : (...args: Parameters) => Exact<Returned, Allowed>
    : Exact<Given, Allowed>;

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
  | OnlyWord<unknown>
  | LazyWord<unknown>
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
 * One signature: a second would let the first fix the literal's type and
 * report a typo at the call instead of at its key. A rule read from the
 * schema (`(schema) => entries`) runs, untyped by this signature.
 */
export type RuleFunction<T extends AnyTarget> = <const R = RuleInput<T>>(
  rules: R &
    (RuleInput<T> | FromSchema<T, RuleInput<T>>) &
    NoInfer<ExactEntries<R, RuleInput<T>>>
) => Part<T, RuleFacts<R, ModelName<T>>>;

/** Same shape as `rule`: `D` unconstrained, typed by `DefaultsInput<T>` beside it. */
type DefaultsFunction<T extends AnyTarget> = <const D = DefaultsInput<T>>(
  defaults: D &
    (DefaultsInput<T> | FromSchema<T, DefaultsInput<T>>) &
    NoInfer<ExactEntries<D, DefaultsInput<T>>>
) => Part<T, DefaultsFacts<D, ModelName<T>>>;

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

/** `oneOf(...)`, `accepts(schema)` or `bound(schema)`: one spelling each (D1). */
export type ArgSource = ArgDeclaration<unknown, Operations, boolean>;

type ValueOf<D> =
  D extends ArgDeclaration<infer Value, Operations, boolean> ? Value : never;

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
    readonly [Name in keyof D]: PlacedArgument<
      ValueOf<D[Name]>,
      PropertyKey,
      OperationsOf<D[Name]>
    >;
  }
>;

type ArgsFunction<T extends AnyTarget> = <
  const D extends Readonly<Record<string, ArgSource>> = Readonly<
    Record<string, ArgSource>
  >,
>(
  declarations: D
) => Part<T, ArgsFacts<D>>;

// =============================================================================
// methods((scope) => ({ $client: … })), modelMethods((scope) => ({ model: { … } }))
// =============================================================================

type ClientKeys<R> = Extract<keyof R, `$${string}`>;

/**
 * A factory that takes the typed scope reads the client's types at this
 * step: it is a result consumer. One that takes nothing reads nothing typed,
 * and types its methods' results from their delegate through a `this`
 * parameter.
 */
export type MethodsFacts<
  R,
  Consumer extends boolean,
  Names extends string = string,
> = Facts<
  { readonly [Key in ClientKeys<R>]: R[Key] },
  {
    readonly [M in Exclude<keyof R, ClientKeys<R>> & Names]: R[M] extends (
      ...args: never[]
    ) => infer Methods
      ? Methods
      : R[M];
  },
  NoArguments,
  never,
  never,
  NoFields,
  NoFields,
  Consumer
>;

/**
 * Whether a methods factory reads the client's types: it takes the scope,
 * or one of its model entries is a function of the delegate (the runtime
 * calls it with the delegate and the scope).
 */
export type ConsumesResults<F extends (...args: never[]) => unknown> =
  Parameters<F> extends readonly []
    ? [TakesDelegate<ReturnType<F>>] extends [never]
      ? false
      : true
    : true;

type TakesDelegate<R> = {
  [M in keyof R]: M extends `$${string}`
    ? never
    : R[M] extends (...args: never[]) => unknown
      ? R[M] extends () => unknown
        ? never
        : M
      : never;
}[keyof R];

export type MethodsScope<T extends AnyTarget> = ExtensionClientScope<
  T["config"],
  T["state"]
>;

/**
 * What a client method cannot be named: a core member, a model (a schema key
 * may begin with `$`), a method an earlier extension or an earlier part
 * added. A later model method of an earlier one's name is refused where it
 * is applied only: a plugin generic over the chain cannot see that name.
 */
type TakenClientKey<T extends AnyTarget> =
  | keyof VibORMClientMembers<VibORMConfig, ExtensionStateConstraint>
  | keyof RawSurface
  | (string extends ModelName<T> ? never : ModelName<T>)
  | keyof T["state"]["client"]
  | keyof T["own"]["client"];

type IsMethod<V> = V extends (...args: never[]) => unknown ? unknown : never;

/** A model's methods: functions, never a core operation nor `then` (the delegate would be a thenable). */
type ModelMethodsCheck<E> = E extends (...args: never[]) => unknown
  ? unknown
  : {
      readonly [Name in keyof E]: Name extends Operations | "then"
        ? never
        : IsMethod<E[Name]>;
    };

/**
 * What the factory may return, key by key: for `methods`, a `$` client
 * method under a free name; for `modelMethods`, a model's methods. A refused
 * key reads `never`, so the error is at the key. A valid one reads
 * `unknown`, never a signature (see `MethodsFunction`).
 */
export type MethodsCheck<
  R,
  T extends AnyTarget,
  Of extends "client" | "model",
> = {
  readonly [Key in keyof R]: Of extends "client"
    ? Key extends `$${string}`
      ? Key extends TakenClientKey<T>
        ? never
        : IsMethod<R[Key]>
      : never
    : Key extends ModelName<T>
      ? ModelMethodsCheck<R[Key]>
      : never;
};

/**
 * The factory's own type is inferred (`F`) and checked against itself
 * (F-bounded). The returned object must not get a function-typed contextual
 * type: TypeScript would instantiate a generic method such as
 * `restore<Self>(this: Self, …)` at once, and `Self` would be lost.
 */
type MethodsFunction<T extends AnyTarget> = <
  F extends (
    scope: MethodsScope<T>
  ) => MethodsCheck<ReturnType<F>, T, "client"> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
) => Part<T, MethodsFacts<ReturnType<F>, ConsumesResults<F>, never>>;

/** `modelMethods`, typed as `methods` is: a model's methods under its name. */
type ModelMethodsFunction<T extends AnyTarget> = <
  F extends (
    scope: MethodsScope<T>
  ) => MethodsCheck<ReturnType<F>, T, "model"> = (
    scope: MethodsScope<T>
  ) => object,
>(
  factory: F
) => Part<T, MethodsFacts<ReturnType<F>, ConsumesResults<F>, ModelName<T>>>;

// =============================================================================
// fields({ model: { name: { needs, compute } } })
// =============================================================================

type FieldsFunction<T extends AnyTarget> = <
  const Declared extends object = object,
  Needs = unknown,
>(
  fields: Declared & FieldsInference<T["config"], T["state"]["fields"], Needs>
) => Part<
  T,
  Facts<
    NoMethods,
    NoMethods,
    NoArguments,
    never,
    never,
    ComputedFieldTypes<
      Pick<Declared, Extract<keyof Declared, ModelName<T> | "$allModels">>
    >
  >
>;

// =============================================================================
// parts<Of>(): the vocabulary bound to one target
// =============================================================================

/**
 * The vocabulary typed against one target. Each builder's target is fixed,
 * never inferred: a bound part is often written alone (`typed.rule({…})`,
 * passed to `extension` later), and an inferred target is still unresolved
 * while its literal is typed, so a word inside it would read nothing. A
 * bound part sees the client, not its siblings' arguments; inside a bound
 * extension the free parts see those (`typed.extension("x", args(…),
 * rule(…))`).
 */
export interface Parts<T extends AnyTarget> {
  readonly extension: BoundExtension<T>;
  readonly call: CallFunction<Within<T>>;
  readonly around: AroundFunction<Within<T>>;
  readonly target: TargetFunction<Within<T>>;
  readonly unit: UnitFunction<Within<T>>;
  readonly rule: RuleFunction<Within<T>>;
  readonly defaults: DefaultsFunction<Within<T>>;
  readonly disclosure: DisclosureFunction<Within<T>>;
  readonly args: ArgsFunction<Within<T>>;
  readonly methods: MethodsFunction<Within<T>>;
  readonly modelMethods: ModelMethodsFunction<Within<T>>;
  readonly fields: FieldsFunction<Within<T>>;
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
    ? Target<LinkedConfigOf<C>, X, EmptyFacts>
    : Of extends VibORMConfig["schema"]
      ? Target<
          LinkedClientConfig<VibORMConfig<Of>>,
          ExtensionStateConstraint,
          EmptyFacts
        >
      : never;

/**
 * The operation sets `target`, `.on(...)` and `.required(...)` take, beside
 * the client's `CacheableOperations` (reads) and `MutationOperations` (writes).
 */
export type DeleteOperations = "delete" | "deleteMany";
export type SelectingOperations = Exclude<Operations, "create" | "createMany">;
