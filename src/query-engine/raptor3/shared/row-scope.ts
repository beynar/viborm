import { parseProviding } from "@validation/primitives/object";
import type { PreparedDomain } from "./query";
import type { Input } from "./schema";

/**
 * `where` inputs per model (its TS name), as admission left them: a value the
 * call supplies is a {@link Parameter}, a test of one a {@link Condition}. They
 * AND with each other; a model with none is not narrowed. Each list is
 * indexed by layer, the declaring `rows` member's place in the chain, so a
 * layer stating nothing for the model leaves a hole.
 */
export type ModelDomain = ReadonlyMap<string, readonly Input[]>;

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
   * Per model (its TS name), indexed by layer as {@link ModelDomain} is, the
   * predicates of the model's verbs. A model absent here judges a write by
   * its purpose's predicates alone.
   */
  readonly verbs?: ReadonlyMap<string, readonly (ModelVerbs | undefined)[]>;
  /**
   * Whether some model's verbs may declare a projection key or a read-gated
   * field: when not, no model is asked for them. The maps may be resolved a
   * model at a time, so they are never walked to find out.
   */
  readonly projects?: boolean;
  /**
   * Per model (its TS name), the order its reads take when the caller gives
   * none (`orderBy` input, as admitted): a root `findMany`/`findFirst`, a
   * to-many relation read at any depth, and a paged aggregate's window.
   */
  readonly order?: ReadonlyMap<string, readonly Input[]>;
}

/**
 * One layer's predicates for one model's verbs, as admission left them: `read`
 * ANDs with the layer's predicate at every purpose, a write's verb with its
 * candidates beside them (R2). An update takes, per field its data writes,
 * that field's predicate, else `update`'s. The row a write produces is
 * judged as a value (R4): a created row at `place`, absent where the layer
 * does not judge creates; an updated row at the predicates that judged its
 * old row and, per field it writes, that field's `moves` predicate.
 */
export interface ModelVerbs {
  readonly read: Input;
  readonly update: Input;
  readonly delete: Input;
  readonly writes: ReadonlyMap<string, Input>;
  readonly place?: Input;
  readonly moves: ReadonlyMap<string, Input>;
  /**
   * Self relations, each held by this model's key, whose links stay
   * acyclic: an update writing one is refused where its new target is the
   * row itself or a row below it. Lazy: the list is resolved only for an
   * update writing the key of one of `candidates`.
   */
  readonly acyclic: readonly string[] | LazyRelations;
  /** The projection key the layer declares on the model (K5). */
  readonly evidence?: ModelEvidence;
  /**
   * Per read-gated field, the predicate a row holds, beside `read`, where it
   * carries the field (K5).
   */
  readonly reads: ReadonlyMap<string, Input>;
}

/**
 * A projection key and what it reports per row, each name with its admitted
 * predicate in declared order: whether each holds beside `read`, or, when
 * `ordered`, the last that does.
 */
export interface ModelEvidence {
  readonly as: string;
  readonly names: readonly (readonly [string, Input])[];
  readonly ordered: boolean;
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
 * A model's stamps: what the call's extensions write on every create, and on
 * every update, tombstones too. Each is scalar `data` input, as declared with
 * the call's control values put in: constants and, on an update, the field's
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
 * admission. A field whose control the call left out is not written, so it
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
 * One root call's row facts, resolved from its controls outside the engine:
 * the engine never sees a mode or an extension's name, and a control's only
 * as the key a parameter reads its value under ({@link CallValues}). Its domains
 * are shared by every call that resolves to the same ones; stamps that name a
 * control are the call's own.
 */
export interface CallRows {
  /** The domain the call's own controls select. */
  readonly domain: RowDomain;
  /**
   * The domain an absent control selects: what a tombstoning delete takes,
   * and every other layer a layer's own traversals read (R5).
   */
  readonly defaults: RowDomain;
  /**
   * Per managed model, what its deletes write; absent when the call deletes
   * physically (its controls match the declaration's `removeWhen`).
   */
  readonly tombstones?: ReadonlyMap<string, Tombstone>;
  /** Per model (its TS name), the fields its creates and updates write. */
  readonly stamps?: ReadonlyMap<string, ModelStamps>;
  /** What the domains' parameters read; absent when no predicate names one. */
  readonly values?: CallValues;
}

/** A call's admitted controls, and how an absent value resolves (R6). */
export interface CallValues {
  readonly controls: Readonly<Record<string, unknown>>;
  /** An absent value of `control` on `model` matches nothing; else it drops. */
  readonly required: (control: string, model: string) => boolean;
}

/**
 * A value a domain predicate reads from its call, prepared once and read at
 * lowering: a control's value, or a field of it along `path`; with no
 * control, the call's one instant. `null` is absent: a parameter never lowers
 * to `IS NULL`. Its own fields are its spelling (`{ control, path }` or
 * `{ now: true }`), which no literal of a declaration can be, so a cache key
 * over declarations tells the two apart.
 */
export class Parameter {
  readonly control?: string;
  readonly path?: string;
  readonly now?: true;
  readonly #keys: readonly string[];
  constructor(control?: string, path?: string) {
    if (control === undefined) this.now = true;
    else this.control = control;
    if (path !== undefined) this.path = path;
    this.#keys = path === undefined ? [] : path.split(".");
    Object.freeze(this);
  }
  /** The call's value, `undefined` when absent. */
  read(values: CallValues | undefined, instant: () => Date): unknown {
    if (this.control === undefined) return instant();
    let value = values?.controls[this.control];
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
 * relation. Its own fields are its spelling, so a cache key reads it as
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
 * Its own field is its spelling, with the model by name, so a cache key over
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
  /** The default domain, prepared once per engine view. */
  readonly defaults: PreparedDomain;
  /**
   * The call's one instant (a tombstone's, and `{ now: true }`'s): sampled at
   * its first use and kept for the prepared call's lifetime, so every
   * occurrence of every attempt shares it.
   */
  instant(): Date;
}
