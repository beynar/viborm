import { parseProviding } from "@validation/primitives/object";
import type { PreparedDomain } from "./query";
import type { Input } from "./schema";

/**
 * Plain `where` inputs per model (its TS name), as the extension wrote them,
 * with any control's value already put in outside the engine: preparation
 * reads a `where` input's shorthand itself, so none is admitted first. They
 * AND with each other; a model with none is not narrowed.
 */
export type ModelDomain = ReadonlyMap<string, readonly Input[]>;

/**
 * The rows an operation may take, by purpose: its own candidates (`root`) and
 * rows it reaches through a relation (`related`).
 */
export interface RowDomain {
  readonly root: ModelDomain;
  readonly related: ModelDomain;
}

/**
 * Which rows a candidate lookup takes: the call's own (`root`) or rows reached
 * through a relation (`related`). A lookup that names no purpose is a premise
 * or physical: it takes exactly the selector it is handed.
 */
export type RowPurpose = keyof RowDomain;

/** What a delete of one model writes instead of removing the row. */
export interface Tombstone {
  /** The DateTime field that receives the call's one instant. */
  readonly at?: string;
  /** Constant scalar data, written beside it. */
  readonly assign: Input;
}

/** What the call's extensions write on one kind of write of one model. */
export interface Stamp {
  /**
   * Scalar `data` input, as declared with the call's control values put in:
   * constants and, on an update, the field's update operators.
   */
  readonly values: Input;
  /**
   * Which extension writes each field: a caller who writes it is refused,
   * even when the call left it out of `values` (its control absent).
   */
  readonly owners: Readonly<Record<string, string>>;
}

/** A model's stamps: on every create, and on every update, tombstones too. */
export interface ModelStamps {
  readonly create?: Stamp;
  readonly update?: Stamp;
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
    (model, field) => stamps.get(model)?.create?.values[field] !== undefined,
    parse
  );

/**
 * One root call's row facts, resolved from its controls outside the engine:
 * the engine never sees a control or a mode, and an extension's name only as
 * the owner a refusal names. Its domains are shared by every call that
 * resolves to the same ones; stamps that name a control are the call's own.
 */
export interface CallRows {
  /** The domain the call's own controls select. */
  readonly domain: RowDomain;
  /** The domain an absent control selects: what a tombstoning delete takes. */
  readonly defaults: RowDomain;
  /**
   * Per managed model, what its deletes write; absent when the call deletes
   * physically (its controls match the declaration's `removeWhen`).
   */
  readonly tombstones?: ReadonlyMap<string, Tombstone>;
  /** Per model (its TS name), the fields its creates and updates write. */
  readonly stamps?: ReadonlyMap<string, ModelStamps>;
}

/** The row facts one prepared call carries, and its one instant. */
export interface CallScope {
  readonly rows: CallRows;
  /** The call's domain, prepared once per engine view. */
  readonly domain: PreparedDomain;
  /** The default domain, prepared once per engine view. */
  readonly defaults: PreparedDomain;
  /**
   * The call's deletion instant: sampled at its first use and kept for the
   * prepared call's lifetime, so every occurrence of every attempt shares it.
   */
  instant(): Date;
}
