/**
 * PROJECTABLE SCALARS — the one definition of "which scalars a query may ask
 * for", shared by `select`, `omit`, and the default projection.
 *
 * Three layers can hide a scalar from a result. They are NOT the same kind of
 * thing, and the difference is the whole precedence story:
 *
 *  1. **Model-level `.omit()`** (`src/schema/model/model.ts`) is SCHEMA TRUTH.
 *     It exists so a column like `passwordHash` can be declared once and never
 *     leave the database, so it is a HARD exclusion: the field is not in the
 *     `select` schema, not in the `omit` schema, and not in the result type.
 *     No client option and no query argument can put it back. Asking for it is
 *     an "Unknown key" parse failure, not a silent empty column.
 *  2. **Client-level `omit`** (`defaultOmit()({ … })`) is a DEFAULT. It
 *     drops the field from projections that did not name one, and a query
 *     overrides it per field with `omit: { field: false }` or by naming the
 *     field in an explicit `select`.
 *  3. **Query-level `omit`** is per call, and wins over the client default.
 *
 * Only layer 1 is visible here — layers 2 and 3 are ordinary values that travel
 * in the args, and the client merges 2 into 3 before validation ever runs
 * (`resolveClientOmit`, `src/client/omit.ts`). That is deliberate: a per-client
 * default must not change what the schema ACCEPTS, or two clients over the same
 * models would disagree about which payloads are valid.
 */

import type { AnyModel } from "@schema/model";
import type { StringKeyOf } from "@schema/model/helper";
import type { Cardinality } from "@schema/relation/static-membership";
import { viewFacts } from "@schema/view/facts";

type ModelStateOf<M extends AnyModel> = M["~"]["state"];

/**
 * The keys a model's `.omit()` hides for good. `undefined` (the common case,
 * no `.omit()` at all) contributes nothing.
 */
export type ModelOmittedKeys<M extends AnyModel> =
  ModelStateOf<M>["omit"] extends Record<string, true>
    ? StringKeyOf<ModelStateOf<M>["omit"]>
    : never;

/** Every scalar of the model that a query is allowed to project. */
export type ProjectableScalarKeys<M extends AnyModel> = Exclude<
  StringKeyOf<ModelStateOf<M>["scalars"]>,
  ModelOmittedKeys<M>
>;

/**
 * Runtime mirror of {@link ProjectableScalarKeys}. Order follows the model's
 * declaration order, which is the order the default projection emits columns
 * in — callers depend on it for stable SELECT lists.
 */
export const projectableScalarNames = (model: AnyModel): readonly string[] => {
  const state = model["~"].state;
  let names = projectable.get(state);
  if (names === undefined) {
    const omitted = state.omit;
    const all = Object.keys(state.scalars);
    names = Object.freeze(
      omitted
        ? all.filter(
            (name) => !Object.hasOwn(omitted, name) || omitted[name] !== true
          )
        : all
    );
    projectable.set(state, names);
  }
  return names;
};
/** The names, once per model state: a default projection reads them per call. */
const projectable = new WeakMap<object, readonly string[]>();

/** The keys of a selection its value does not switch off. */
type AskedKeys<Selection> = {
  [K in keyof Selection]: Selection[K] extends false | undefined ? never : K;
}[keyof Selection];

/**
 * A view's JSON columns, by name (`ViewFacts.documents`): each non-scalar
 * selection of its declared query, a `_count` where it counts a relation;
 * without a selection, the columns of a source view the query does not omit,
 * then what it includes. A table's state declares no view, so it has none,
 * and neither has `Model<any>`: read while `M` is still at its constraint, a
 * source of `any` state would have no end (TS2589).
 */
export type ViewDocumentKeys<M extends AnyModel> = StateDocumentKeys<
  ModelStateOf<M>
>;

/** {@link ViewDocumentKeys}, read off a model's state. */
export type StateDocumentKeys<State> = 0 extends 1 & State
  ? never
  : State extends {
        readonly view: {
          readonly source: infer Source extends AnyModel;
          readonly query: infer Query;
        };
      }
    ? DeclaredDocumentKeys<Source, Query>
    : never;

/** The JSON columns a view of `Source` declared by `Query` has. */
export type DeclaredDocumentKeys<
  Source extends AnyModel,
  Query,
> = Query extends {
  readonly by: unknown;
}
  ? // An aggregated view's columns are flat: it holds no document.
    never
  : ViewDocumentsOf<Source, Query>;

type ViewDocumentsOf<Source extends AnyModel, Query> = Exclude<
  Query extends { select: infer Selection extends object }
    ? CountedKeys<
        Source,
        Exclude<AskedKeys<Selection>, ProjectableScalarKeys<Source>> & string,
        Selection
      >
    :
        | ViewDocumentKeys<Source>
        | (Query extends { include: infer Included extends object }
            ? CountedKeys<Source, AskedKeys<Included> & string, Included>
            : never),
  Query extends { omit: infer Omitted extends object }
    ? AskedKeys<Omitted>
    : never
>;

/**
 * A projection's non-scalar keys, `_count` only where it is a column: a read
 * gives a `_count` that counts no relation no key, so a view has no column
 * for it (`countsRelation` in `s.view`).
 */
type CountedKeys<
  Source extends AnyModel,
  Keys,
  Projection,
> = "_count" extends Keys
  ? CountsRelation<
      Source,
      Projection extends { readonly _count: infer Count } ? Count : never
    > extends true
    ? Keys
    : Exclude<Keys, "_count">
  : Keys;

/**
 * Whether a `_count` selection is a column of a view on `Source`: a source
 * view's own `_count` column; else a `select` naming a relation it does not
 * switch off; else, as `true`, a to-many relation of the source to count.
 */
type CountsRelation<
  Source extends AnyModel,
  Count,
> = "_count" extends ViewDocumentKeys<Source>
  ? true
  : Count extends { readonly select: infer Counted }
    ? [AskedKeys<Counted>] extends [never]
      ? false
      : true
    : Count extends object
      ? false
      : "many" extends RelationCardinalities<ModelStateOf<Source>["relations"]>
        ? true
        : false;

/** The cardinality of each relation of a relation map. */
type RelationCardinalities<Relations> = {
  [K in keyof Relations]: Cardinality<Relations[K]>;
}[keyof Relations];

/**
 * The names a projection that names none reads: every projectable scalar,
 * then a view's JSON columns, which a view row returns by default as its
 * declared query returns them. A table's are its projectable scalars.
 */
export const defaultProjectionNames = (model: AnyModel): readonly string[] => {
  const documents = viewFacts(model)?.documents;
  if (documents === undefined) return projectableScalarNames(model);
  const state = model["~"].state;
  let names = viewNames.get(state);
  if (names === undefined) {
    names = Object.freeze([...projectableScalarNames(model), ...documents]);
    viewNames.set(state, names);
  }
  return names;
};
/** A view's default names, once per view state. */
const viewNames = new WeakMap<object, readonly string[]>();
