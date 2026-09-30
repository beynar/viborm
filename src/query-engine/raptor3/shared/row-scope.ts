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

/**
 * One root call's row facts, resolved from its controls outside the engine:
 * the engine never sees a control, a mode or an extension name. Objects are
 * shared by every call that resolves to the same facts.
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
