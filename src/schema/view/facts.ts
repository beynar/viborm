/**
 * What makes a model a database view: the facts `s.view` declares, held
 * beside the typed model state like `rawIndexes`. Every layer that must tell
 * a view from a table asks {@link viewFacts}; nothing else marks one.
 */

import type { TimeStep } from "@validation/model/args/time-step";
import type { AnyModel, ModelState } from "../model";

/** An aggregate an aggregated view's column holds. */
export type ViewAggregate = "_count" | "_avg" | "_sum" | "_min" | "_max";

/** Where one column of an aggregated view comes from. */
export interface ViewColumnOrigin {
  /** The source field it reads: absent for a count of rows. */
  readonly field?: string;
  /** The aggregate it holds of that field: absent for a grouped field. */
  readonly aggregate?: ViewAggregate;
  /** The time step a grouped field is taken by. */
  readonly step?: TimeStep;
}

/**
 * What makes a view aggregated: its query is what `groupBy` takes on its
 * source (`by`, `having`, `_count`, `_sum`, …), and its rows are groups.
 */
export interface AggregatedViewFacts {
  /** The grouped fields, in the order `by` lists them: the view's key when none is nullable. */
  readonly by: readonly string[];
  /**
   * Each column, by field name, in the order of the view's columns: a
   * grouped field under its own name, an aggregate under its own
   * (`count`, `sumAmount`, …).
   */
  readonly origins: Readonly<Record<string, ViewColumnOrigin>>;
  /**
   * The scalars and the compound key the view derived, which a source does
   * not hold: what its model's state may hold and nothing beside (W002).
   */
  readonly scalars: ModelState["scalars"];
  readonly compoundId: ModelState["compoundId"];
}

export interface ViewFacts {
  /** The model or view whose rows this view reads. */
  readonly source: AnyModel;
  /** What `findMany` takes on the source, as declared; `groupBy` for an aggregated view. */
  readonly query: Readonly<Record<string, unknown>>;
  /**
   * The view's scalar columns, by field name: the source scalars the query
   * projects, in the source's order; an aggregated view's grouped fields and
   * aggregates, in its columns' order, a name twice where two columns take it
   * and a name with no scalar where it is longer than a column's (W004).
   */
  readonly columns: readonly string[];
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
  /**
   * Declared `.materialized({ refresh: "auto" })`: a table the database keeps
   * current from its source's writes, by triggers (SurrealDB keeps every view
   * so), on every database.
   */
  readonly refresh?: "auto";
  /** Present when the query groups the source's rows (`by`): see {@link AggregatedViewFacts}. */
  readonly aggregated?: AggregatedViewFacts;
}

/** The state of a view, at the type level: what `.materialized()` is called on. */
export interface DeclaredViewState {
  readonly view: object;
}

/** What `.materialized()` takes. */
export interface MaterializedOptions {
  /**
   * `"auto"`: the view is a table its source's triggers keep current at each
   * write, rather than rows `$refresh()` computes again.
   */
  readonly refresh?: "auto";
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

/**
 * The source field whose values a view's column holds, read through
 * {@link ViewFacts.aggregated}: the column's own name in a view of rows; in
 * an aggregated view a grouped field's, or the one a `_min` or a `_max`
 * picks a value of; none for a count, a sum, an average or a period, which
 * hold values of their own.
 */
export function heldField(facts: ViewFacts, field: string): string | undefined {
  const origin = facts.aggregated?.origins[field];
  if (origin === undefined) return field;
  if (origin.step !== undefined) return;
  const { aggregate } = origin;
  return aggregate === undefined || aggregate === "_min" || aggregate === "_max"
    ? origin.field
    : undefined;
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
