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
 *  2. **Client-level `omit`** (`createClient({ omit: … })`) is a DEFAULT. It
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
export const projectableScalarNames = (model: AnyModel): string[] => {
  const state = model["~"].state;
  const omitted = state.omit;
  const names = Object.keys(state.scalars);
  if (!omitted) return names;
  return names.filter(
    (name) => !Object.hasOwn(omitted, name) || omitted[name] !== true
  );
};
