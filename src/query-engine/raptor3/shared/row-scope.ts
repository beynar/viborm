import type { Judge } from "@extensions/judge";
import type { Projection } from "@extensions/projection";
import type { AnyModel } from "@schema/model";
import { parseProviding } from "@validation/primitives/object";
import type { PreparedGuardFailure } from "../../types";
import type { Writer } from "../write/statements";
import type {
  PreparedDomain,
  PreparedPredicate,
  PreparedSelector,
  Queries,
  Query,
} from "./query";
import type { EngineSchema, Input } from "./schema";
import type { Membership } from "./storage";

/**
 * What each model (by its TS name) holds, asked a model at a time: what
 * answers may build a model's entry the first time it is asked, so an entry
 * declared lazily is resolved only for a model a call reaches.
 */
export interface ByModel<T> {
  get(model: string): T | undefined;
}

/**
 * `where` inputs per model (its TS name), as admission left them: a value the
 * call supplies is a {@link Parameter}, a test of one a {@link Condition}. They
 * AND with each other; a model with none is not narrowed. Each list is
 * indexed by layer, the declaring `rows` member's place in the chain, so a
 * layer stating nothing for the model leaves a hole.
 */
export type ModelDomain = ByModel<readonly Input[]>;

/** Relations named on demand, among the ones that could be named. */
export interface LazyRelations {
  readonly candidates: readonly string[];
  resolve(): readonly string[];
}

/**
 * The rows an operation may take, by purpose: its own candidates (`root`) and
 * rows it reaches through a relation (`related`).
 */
export interface RowDomain {
  readonly root: ModelDomain;
  readonly related: ModelDomain;
  /**
   * What makes a layer's node of a predicate that reads its call (an
   * argument, the instant, a test of an argument): brought by the words
   * that read it. Absent, a layer is what it states.
   */
  readonly layered?: (
    layer: number,
    model: string,
    predicate: PreparedPredicate
  ) => PreparedPredicate;
  /**
   * The same domain read where every argument with a default takes it
   * ({@link CallValues.defaults}): what `CallScope.defaults` prepares.
   * Absent where no argument a predicate reads has a default.
   */
  readonly defaults?: RowDomain;
  /** What a layer's own whole-table sets hold (`rows.confine`), in every mode. */
  readonly confine?: ModelDomain;
  /**
   * Per model (its TS name), indexed by layer as {@link ModelDomain} is, the
   * predicates of the model's verbs. A model absent here judges a write by
   * its purpose's predicates alone.
   */
  readonly verbs?: ByModel<readonly (ModelVerbs | undefined)[]> & {
    has(model: string): boolean;
  };
  /**
   * What judges the rows a write produces, made once per prepared domain:
   * stated where some model's verbs judge them, by what reads the verbs.
   */
  readonly judge?: (domain: PreparedDomain) => Judge;
  /**
   * What a read may carry beside the rows (projection keys) and what it
   * hides of them (read-gated fields), made once per prepared domain: stated
   * where some model's verbs may declare either, by what reads the verbs.
   */
  readonly project?: (domain: PreparedDomain) => Projection;
  /**
   * What an `excluded` layer states its own whole-table sets of a model hold
   * (`confine`), made once per prepared domain: stated where some member
   * confines one, by what reads the verbs.
   */
  readonly bound?: (
    domain: PreparedDomain
  ) => (
    model: AnyModel,
    excluded: readonly number[]
  ) => PreparedSelector | undefined;
  /**
   * Per model (its TS name), the order its reads take when the caller gives
   * none (`orderBy` input, as admitted): a root `findMany`/`findFirst`, a
   * to-many relation read at any depth, and a paged aggregate's window.
   */
  readonly order?: ReadonlyMap<string, readonly Input[]>;
}

/**
 * One layer's entry for one model beyond its filters, its predicates `P`:
 * as written (`unknown`), then as admission left them (`Input`). `read`
 * (an entry given lazily's `read.where`) ANDs with the layer's predicate at
 * every purpose, a write's verb with its candidates beside them (R2); a verb
 * left out restricts nothing. An update takes, per field its data writes,
 * that field's predicate, else `update`'s. The row a write produces is
 * judged as a value (R4) where a check said so: a created row at `place`;
 * an updated row at the predicates that judged its old row, `check`, and per
 * field it writes, that field's `moves` predicate.
 */
export interface ModelVerbs<P = Input> {
  readonly read?: P;
  /**
   * What a row a write returns holds for the layer's projection key and
   * read-gated fields to show, where it is not `read` (an eager entry's
   * read filter is the layer's own).
   */
  readonly shown?: P;
  readonly update?: P;
  readonly delete?: P;
  readonly writes?: ReadonlyMap<string, P>;
  readonly place?: P;
  /** What the row an update leaves holds, where it writes a field this reads. */
  readonly check?: P;
  readonly moves?: ReadonlyMap<string, P>;
  /**
   * Self relations, each held by this model's key, whose links stay
   * acyclic: an update writing one is refused where its new target is the
   * row itself or a row below it. Lazy: the list is resolved only for an
   * update writing the key of one of `candidates`.
   */
  readonly cycles?: readonly string[] | LazyRelations;
  /** The projection key the layer declares on the model (K5). */
  readonly as?: string;
  /** What it reports per row: each name with its predicate, in declared order. */
  readonly facts?: ReadonlyMap<string, P>;
  /**
   * Per read-gated field, the predicate a row holds, beside `read`, where it
   * carries the field (K5).
   */
  readonly reads?: ReadonlyMap<string, P>;
  /** A check was written on the entry: the rows its writes produce are judged. */
  readonly judge?: (domain: PreparedDomain) => Judge;
}

/**
 * The verb a write lookup takes beside its purpose (R3): `delete`, or `update`
 * with the fields the occurrence's data writes, none when it writes only
 * stamps and generated values.
 */
export interface RowJudgement {
  readonly verb: "update" | "delete";
  readonly writes: readonly string[];
  /**
   * The caller writes a field the model's tombstone manages (sets or clears
   * a marker by hand, a restore): the row is also judged at `delete`, as the
   * tombstone the extension writes is.
   */
  readonly marks?: true;
}

/**
 * Which rows a candidate lookup takes: the call's own (`root`) or rows reached
 * through a relation (`related`). A lookup that names no purpose is a premise
 * or physical: it takes exactly the selector it is handed.
 */
export type RowPurpose = "root" | "related";

/** What a delete of one model writes instead of removing the row. */
export interface Tombstone {
  /** The DateTime field that receives the call's one instant. */
  readonly at?: string;
  /** Constant scalar data, written beside it. */
  readonly assign: Input;
}

/**
 * What the models that keep the rows they delete write instead, by model,
 * and what a kept row meets where the database would have refused its
 * removal: said by what declares the keeping.
 */
export interface Tombstones extends ReadonlyMap<string, Tombstone> {
  /** What a row of `model` takes instead of going; none where its model removes its rows. */
  marks(writer: Writer, model: AnyModel): Input | undefined;
  /** Among the rows that still reference a kept row, the one a call reaches it through restricts nothing. */
  referenced(
    schema: EngineSchema,
    edge: Membership | undefined,
    of?: Input
  ): true | { readonly slot: string; readonly identity: Input };
  /** What a kept row is refused with where a row still references it. */
  restriction(
    schema: EngineSchema,
    model: AnyModel
  ): PreparedGuardFailure | undefined;
  /** Every row of `selector` locked, answered as one row. */
  lock(queries: Queries, selector: PreparedSelector): Query;
  /** The rows of `model` a visible member still references, one member excepted by identity. */
  selector(
    queries: Queries,
    model: AnyModel,
    visible: PreparedDomain | undefined,
    except?: { readonly slot: string; readonly identity: Input }
  ): PreparedSelector;
}

/**
 * A model's stamps: what the call's extensions write on every create, and on
 * every update, tombstones too. Each is scalar `data` input, as declared with
 * the call's argument values put in: constants and, on an update, the field's
 * update operators.
 */
export interface ModelStamps {
  readonly create?: Input;
  readonly update?: Input;
}

/**
 * Parse the caller's data where validation knows what the call's create
 * stamps write ({@link parseProviding}, by the model's TS name): a required
 * field a stamp writes may be left out, as the stamp writes it after
 * admission. A field whose argument the call left out is not written, so it
 * is still asked for. `parse` is synchronous; a call without stamps never
 * comes here.
 */
export const parseStamped = <T>(
  stamps: ReadonlyMap<string, ModelStamps>,
  parse: () => T
): T =>
  parseProviding(
    (model, field) => stamps.get(model)?.create?.[field] !== undefined,
    parse
  );

/**
 * One root call's row facts, resolved from its arguments outside the engine:
 * the engine never sees a mode or an extension's name, and an argument's only
 * as the key a parameter reads its value under ({@link CallValues}). Its domains
 * are shared by every call that resolves to the same ones; stamps that name a
 * argument are the call's own.
 */
export interface CallRows {
  /**
   * The rows the call may take: its predicates read the call's values, or,
   * prepared as the default domain, each argument with a default at its
   * default ({@link CallScope.defaults}).
   */
  readonly domain: RowDomain;
  /**
   * Per managed model, what its deletes write; absent when the call deletes
   * physically (what its `keep` reads of the call says so).
   */
  readonly tombstones?: Tombstones;
  /** Per model (its TS name), the fields its creates and updates write. */
  readonly stamps?: ReadonlyMap<string, ModelStamps>;
  /** What the domains' parameters read; absent when no predicate names one. */
  readonly values?: CallValues;
  /** These facts as the engine reads them through one query owner: what states them says how. */
  readonly prepare: (queries: Queries, instant: () => Date) => CallScope;
}

/** A call's admitted arguments, and how an absent value resolves (R6). */
export interface CallValues {
  readonly args: Readonly<Record<string, unknown>>;
  /** An absent value of `arg` on `model` matches nothing; else it drops. */
  readonly required: (arg: string, model: string) => boolean;
  /**
   * The read view under `domain` for a call carrying these values: one per
   * domain where the same object serves every call that passes them and no
   * predicate reads the instant, else the call's own.
   */
  readonly view?: (domain: PreparedDomain, call: CallScope) => Queries;
  /**
   * The values where every argument with a default takes it, where this
   * call's differ: what the default domain reads (`CallScope.defaults`).
   */
  readonly defaults?: CallValues;
}

/**
 * A value a domain predicate reads from its call, prepared once and read at
 * lowering: an argument's value, or a field of it along `path`; with no
 * argument, the call's one instant. `null` is absent: a parameter never lowers
 * to `IS NULL`. Its own fields are its spelling (`{ argument, path }` or
 * `{ now: true }`), which no literal of a declaration can be, so a key
 * over declarations tells the two apart.
 */
export class Parameter {
  readonly arg?: string;
  readonly path?: string;
  readonly now?: true;
  readonly #keys: readonly string[];
  constructor(arg?: string, path?: string) {
    if (arg === undefined) this.now = true;
    else this.arg = arg;
    if (path !== undefined) this.path = path;
    this.#keys = path === undefined ? [] : path.split(".");
    Object.freeze(this);
  }
  /** The call's value, `undefined` when absent. */
  read(values: CallValues | undefined, instant: () => Date): unknown {
    if (this.arg === undefined) return instant();
    let value = values?.args[this.arg];
    for (const key of this.#keys) {
      if (value === null || typeof value !== "object") return undefined;
      value = Object.hasOwn(value, key) ? (value as Input)[key] : undefined;
    }
    return value ?? undefined;
  }
}

/** What a {@link Condition} asks of its value, in the filter vocabulary. */
export type ConditionTest =
  | { readonly exists: boolean }
  | { readonly equals: unknown }
  | { readonly in: readonly unknown[] }
  | { readonly has: unknown }
  | { readonly hasSome: readonly unknown[] };

/** A test of a call value that reads no column: folded per call. */
export class Condition {
  readonly parameter: Parameter;
  readonly test: ConditionTest;
  constructor(parameter: Parameter, test: ConditionTest) {
    this.parameter = parameter;
    this.test = test;
    Object.freeze(this);
  }
  holds(values: CallValues | undefined, instant: () => Date): boolean {
    const value = this.parameter.read(values, instant);
    const test = this.test;
    if ("exists" in test) return (value !== undefined) === test.exists;
    if (value === undefined) return false;
    if ("equals" in test) return Object.is(value, test.equals);
    if ("in" in test) return test.in.includes(value);
    if (!Array.isArray(value)) return false;
    if ("has" in test) return value.includes(test.has);
    return test.hasSome.some((member) => value.includes(member));
  }
}

/**
 * `{ $row: "<field>", up: <n> }` in a domain predicate's value position: that
 * column of the row `up` relation bodies above the one the value is compared
 * in (`0`, the same row; an `$exists` body counts as one). Never past the
 * predicate it is written in, nor across a recursive or polymorphic
 * relation. Its own fields are its spelling, so a key over it reads it as
 * plain data.
 */
export class OuterColumn {
  readonly $row: string;
  readonly up: number;
  constructor(field: string, up: number) {
    this.$row = field;
    this.up = up;
    Object.freeze(this);
  }
}

/**
 * `{ $exists: { <model>: <where> } }` in a domain predicate: whether some row
 * of `model` the call may see matches `where`. It reads no column of the row
 * it judges (an uncorrelated `EXISTS`), so a statement can evaluate it once.
 * Its own field is its spelling, with the model by name, so a key over
 * declarations reads it as plain data.
 */
export class Existence {
  readonly $exists: Readonly<Record<string, Input>>;
  readonly #model: string;
  readonly #where: Input;
  constructor(model: string, where: Input) {
    this.#model = model;
    this.#where = where;
    this.$exists = Object.freeze({ [model]: where });
    Object.freeze(this);
  }
  /** The model whose rows it looks for (its TS name). */
  get model(): string {
    return this.#model;
  }
  /** What one of them must match, admitted with that model's `where`. */
  get where(): Input {
    return this.#where;
  }
}

/** The row facts one prepared call carries, and its one instant. */
export interface CallScope {
  readonly rows: CallRows;
  /** The call's domain, prepared once per engine view. */
  readonly domain: PreparedDomain;
  /**
   * The domain read where every argument with a default takes it: what a
   * tombstoning delete takes, and every other layer a layer's own
   * traversals read (R5). The call's own where its values are the defaults.
   */
  readonly defaults: PreparedDomain;
  /**
   * The call's one instant (a tombstone's, and `{ now: true }`'s): sampled at
   * its first use and kept for the prepared call's lifetime, so every
   * occurrence of every attempt shares it.
   */
  instant(): Date;
}
