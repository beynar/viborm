import v, { type V } from "@validation";
import type { ModelState } from "../../model";
import {
  type CompoundConstraintFilterSchema,
  getCompoundConstraintFilter,
} from "./filter";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 * Uses thunks for recursive self-references
 */
export type WhereSchemaBase<T extends ModelState> = V.Object<
  V.FromObject<T["scalars"], "~.schemas.filter">["entries"] &
    V.FromObject<T["relations"], "~.schemas.filter">["entries"]
>;

export type WhereSchema<T extends ModelState> = V.Object<
  {
    AND: () => V.Optional<
      V.Union<readonly [WhereSchema<T>, V.Array<WhereSchema<T>>]>
    >;
    OR: () => V.Optional<V.Array<WhereSchema<T>>>;
    NOT: () => V.Optional<
      V.Union<readonly [WhereSchema<T>, V.Array<WhereSchema<T>>]>
    >;
  } & WhereSchemaBase<T>["entries"]
>;

export const getWhereSchema = <T extends ModelState>(
  state: T
): WhereSchema<T> => {
  // Build scalar and relation filter entries

  const scalarFilter = v.fromObject<T["scalars"], "~.schemas.filter">(
    state.scalars,
    "~.schemas.filter"
  );
  const relationFilter = v.fromObject<T["relations"], "~.schemas.filter">(
    state.relations,
    "~.schemas.filter"
  );

  // Create the recursive where schema with AND/OR/NOT using thunks
  const whereSchema = v
    .object({
      // Recursive AND/OR/NOT using thunks
      AND: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
      OR: () => v.optional(v.array(whereSchema)),
      NOT: () => v.optional(v.union([whereSchema, v.array(whereSchema)])),
    })
    .extend(scalarFilter.entries)
    .extend(relationFilter.entries);

  return whereSchema;
};

// =============================================================================
// WHERE UNIQUE SCHEMA
// =============================================================================

/**
 * Build whereUnique schema - unique fields + compound constraints
 * Combines single-field uniques with compound ID and compound uniques
 */
export type WhereUniqueSchema<T extends ModelState> = V.Object<
  V.FromObject<T["uniques"], "~.schemas.base">["entries"] &
    CompoundConstraintFilterSchema<T>["entries"]
>;
export const getWhereUniqueSchema = <T extends ModelState>(state: T) => {
  // Single-field unique constraints
  const uniqueFilter = v.fromObject<T["uniques"], "~.schemas.base">(
    state.uniques,
    "~.schemas.base"
  );

  // Add compound constraints (ID + uniques) using the compound filter helpers
  const compoundConstraintFilter = getCompoundConstraintFilter(state);

  return v.object({
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  });
};
