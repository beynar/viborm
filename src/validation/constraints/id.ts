import type { Model } from "@schema/model/model";
import v, { type V } from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
import { type CompoundIdSchema, getCompoundIdSchema } from "./compound";

type AnyModel = Model<any>;

// =============================================================================
// ID SCALARS - Scalars marked with .id()
// =============================================================================

/**
 * Extract names of scalar fields where isId is true
 */
type IdName<M extends AnyModel> = {
  [S in keyof M["~"]["state"]["scalars"]]: M["~"]["state"]["scalars"][S]["~"]["state"]["isId"] extends true
    ? S
    : never;
}[keyof M["~"]["state"]["scalars"]];

/**
 * Build entries for scalar ID fields using their base schema
 */
type ScalarIdEntries<M extends AnyModel> = {
  [K in IdName<M>]: M["~"]["state"]["scalars"][K]["~"]["state"]["base"];
};

/**
 * Combined ID entries (scalar + compound)
 */
type IdEntries<M extends AnyModel> =
  CompoundIdSchema<M> extends { entries: infer E }
    ? E & ScalarIdEntries<M>
    : ScalarIdEntries<M>;

/**
 * Schema type for ID fields (scalar + compound)
 */
export type IdSchema<M extends AnyModel> = V.Object<IdEntries<M>>;

/**
 * Build a schema containing all ID scalar fields from a model.
 * This returns an object schema where each key is an ID field name
 * and the value is validated against the field's base schema.
 *
 * @example
 * const user = s.model({
 *   id: s.string().id(),
 *   name: s.string(),
 * });
 *
 * const idSchema = getIdSchema(user);
 * // Schema: { id: string }
 */
export const getIdSchema = <M extends AnyModel>(model: M): IdSchema<M> => {
  const entries: Record<string, VibSchema> = {};
  const scalars = model["~"].state.scalars;

  // Collect scalar ID fields
  for (const key of Object.keys(scalars)) {
    const scalar = scalars[key];
    if (scalar?.["~"].state.isId === true) {
      entries[key] = scalar["~"].state.base;
    }
  }

  // Start with scalar IDs
  let schema = v.object(entries, { partial: true, nonEmpty: true });

  // Extend with compound ID fields if they exist
  const compoundIdSchema = getCompoundIdSchema(model);
  if (compoundIdSchema?.entries) {
    schema = schema.extend(compoundIdSchema.entries);
  }

  return schema as unknown as IdSchema<M>;
};
