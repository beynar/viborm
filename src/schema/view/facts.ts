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
   * lists them.
   */
  readonly documents: readonly string[];
}

/** The view facts of `model`, or undefined when it is a table. */
export function viewFacts(model: AnyModel): ViewFacts | undefined {
  return (model["~"].state as { view?: ViewFacts }).view;
}
