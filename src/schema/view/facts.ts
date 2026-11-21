/**
 * What makes a model a database view: the facts `s.view` declares, held
 * beside the typed model state like `rawIndexes`. Every layer that must tell
 * a view from a table asks {@link viewFacts}; nothing else marks one.
 */

import type { AnyModel } from "../model";

export interface ViewFacts {
  /** The model or view whose rows this view reads. */
  readonly source: AnyModel;
  /** What `findMany` takes on the source, as declared. */
  readonly query: Readonly<Record<string, unknown>>;
  /**
   * The view's JSON columns, by name: each non-scalar selection of the query
   * (a relation, `_count`, `_aggregate`), in the order the query's projection
   * lists them. The one field written after `s.view`: the schema's
   * resolution settles a `_count: true` over a view source, whose inherited
   * relations it alone knows (`settleCount`).
   */
  documents: readonly string[];
  /**
   * Declared with `.materialized()`: the database stores the view's rows
   * (PostgreSQL's materialized view), so `.index()` may index its columns
   * and `$refresh()` recomputes them. Where a database has no such view it
   * is an ordinary one.
   */
  readonly materialized?: true;
}

/** The state of a view, at the type level: what `.materialized()` is called on. */
export interface DeclaredViewState {
  readonly view: object;
}

/** What `.materialized()` adds to a view's state, at the type level. */
export interface MaterializedViewState {
  readonly view: { readonly materialized: true };
}

/**
 * A view declared `.materialized()`, at the type level: the client types
 * `$refresh` on its delegate alone.
 */
export interface MaterializedView {
  readonly "~": { readonly state: MaterializedViewState };
}

/** The view facts of `model`, or undefined when it is a table. */
export function viewFacts(model: AnyModel): ViewFacts | undefined {
  return (model["~"].state as { view?: ViewFacts }).view;
}

/** The table `model` reads through every view it reads: itself for a table. */
export function viewTable(model: AnyModel): AnyModel {
  let table = model;
  for (let facts = viewFacts(table); facts; facts = viewFacts(table))
    table = facts.source;
  return table;
}
