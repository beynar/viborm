import type { AnyModel } from "@schema/model";
import v, { type V } from "../../primitives/v";
import type { ScalarSchemas } from "../index";
import {
  type CompoundConstraintFilterSchema,
  getCompoundConstraintFilter,
  getUniqueFilter,
  type UniqueFilterSchema,
} from "./filter";

// =============================================================================
// WHERE SCHEMA
// =============================================================================

/**
 * Build full where schema - scalar + relation filters + AND/OR/NOT
 * Uses thunks for recursive self-references
 */
export type WhereSchemaBase<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  V.FromObject<F["scalars"], "filter">["entries"] &
    V.FromObject<F["relations"], "filter">["entries"]
>;

export type WhereSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<
  {
    AND: () => V.Optional<
      V.Union<readonly [WhereSchema<M, F>, V.Array<WhereSchema<M, F>>]>
    >;
    OR: () => V.Optional<V.Array<WhereSchema<M, F>>>;
    NOT: () => V.Optional<
      V.Union<readonly [WhereSchema<M, F>, V.Array<WhereSchema<M, F>>]>
    >;
  } & WhereSchemaBase<M, F>["entries"]
>;

export const getWhereSchema = <M extends AnyModel, F extends ScalarSchemas<M>>(
  fieldSchemas: F
): WhereSchema<M, F> => {
  // Build scalar and relation filter entries

  const scalarFilter = v.fromObject<F["scalars"], "filter">(
    fieldSchemas.scalars,
    "filter"
  );
  const relationFilter = v.fromObject<F["relations"], "filter">(
    fieldSchemas.relations,
    "filter"
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
type WhereUniqueEntries<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = UniqueFilterSchema<M, F>["entries"] &
  CompoundConstraintFilterSchema<M>["entries"];

type WhereUniqueKey<M extends AnyModel, F extends ScalarSchemas<M>> = Extract<
  keyof WhereUniqueEntries<M, F>,
  string
>;

type WhereUniqueOptions<M extends AnyModel, F extends ScalarSchemas<M>> = {
  nonEmpty: true;
  requiresOneOf: readonly [WhereUniqueKey<M, F>[]];
};

export type WhereUniqueSchema<
  M extends AnyModel,
  F extends ScalarSchemas<M>,
> = V.Object<WhereUniqueEntries<M, F>, WhereUniqueOptions<M, F>>;
export const getWhereUniqueSchema = <
  M extends AnyModel,
  F extends ScalarSchemas<M>,
>(
  model: M,
  fieldSchemas: F
): WhereUniqueSchema<M, F> => {
  // Single-field unique constraints
  const uniqueFilter = getUniqueFilter(model, fieldSchemas);

  // Add compound constraints (ID + uniques) using the compound filter helpers
  const compoundConstraintFilter = getCompoundConstraintFilter(model);

  const entries: WhereUniqueEntries<M, F> = {
    ...uniqueFilter.entries,
    ...compoundConstraintFilter.entries,
  };
  const keys = Object.keys(entries) as WhereUniqueKey<M, F>[];

  return v.object(entries, {
    nonEmpty: true,
    requiresOneOf: [keys],
  });
};
