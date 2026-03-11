import type { Model, ModelState } from "@schema/model/model";
import v, { type V } from "@validation/primitives/v";
import type { VibSchema } from "@validation/types";
import {
  type CompoundUniqueSchemas,
  getCompoundUniqueSchemas,
} from "./compound";

type AnyModel = Model<ModelState>;

// =============================================================================
// UNIQUE SCALARS - Fields marked with .unique() or .id()
// =============================================================================

/**
 * Extract names of scalar fields where isUnique is true (includes IDs since IDs are unique)
 */
type UniqueName<M extends AnyModel> = {
  [S in keyof M["~"]["state"]["scalars"]]: M["~"]["state"]["scalars"][S]["~"]["state"]["isUnique"] extends true
    ? S
    : never;
}[keyof M["~"]["state"]["scalars"]];

/**
 * Build entries for scalar unique fields using their base schema
 */
type ScalarUniqueEntries<M extends AnyModel> = {
  [K in UniqueName<M>]: M["~"]["state"]["scalars"][K]["~"]["schemas"]["base"];
};

/**
 * Extract and merge entries from all compound unique schemas (@@id + @@unique)
 */
type CompoundUniqueEntries<M extends AnyModel> =
  CompoundUniqueSchemas<M> extends Record<string, { entries: infer E }>
    ? E extends Record<string, unknown>
      ? {
          [K in keyof CompoundUniqueSchemas<M>]: CompoundUniqueSchemas<M>[K] extends {
            entries: infer E;
          }
            ? E
            : never;
        }[keyof CompoundUniqueSchemas<M>]
      : Record<string, never>
    : Record<string, never>;

/**
 * Flatten union of entries into a single intersection
 */
type UnionToIntersection<U> = (
  U extends unknown
    ? (k: U) => void
    : never
) extends (k: infer I) => void
  ? I
  : never;

/**
 * Combined unique entries (scalar + compound)
 */
type UniqueEntries<M extends AnyModel> = ScalarUniqueEntries<M> &
  UnionToIntersection<CompoundUniqueEntries<M>>;

/**
 * Schema type for unique fields (scalar + compound)
 */
export type UniqueSchema<M extends AnyModel> = V.Object<UniqueEntries<M>>;

/**
 * Build a schema containing all unique scalar fields from a model.
 * This includes both fields marked with .unique() and .id() since IDs are inherently unique.
 *
 * @example
 * const user = s.model({
 *   id: s.string().id(),
 *   email: s.string().unique(),
 *   name: s.string(),
 * });
 *
 * const uniqueSchema = getUniqueSchema(user);
 * // Schema: { id: string, email: string }
 */
export const getUniqueSchema = <M extends AnyModel>(
  model: M
): UniqueSchema<M> => {
  const entries: Record<string, VibSchema> = {};
  const scalars = model["~"].state.scalars;

  // Collect scalar unique fields
  for (const key of Object.keys(scalars)) {
    const scalar = scalars[key];
    if (scalar?.["~"].state.isUnique === true) {
      entries[key] = scalar["~"].schemas.base;
    }
  }

  // Start with scalar uniques
  let schema = v.object(entries, { partial: true, nonEmpty: true });

  // Extend with compound unique fields (includes both @@id and @@unique)
  const compoundSchemas = getCompoundUniqueSchemas(model);
  if (compoundSchemas) {
    for (const constraintName of Object.keys(compoundSchemas)) {
      const compoundSchema = compoundSchemas[constraintName];
      if (compoundSchema?.entries) {
        schema = schema.extend(compoundSchema.entries);
      }
    }
  }

  return schema as unknown as UniqueSchema<M>;
};
