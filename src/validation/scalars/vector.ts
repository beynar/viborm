import type { ScalarState } from "@schema/scalars/common";
import { lazyScalarSchemas } from "../lazy";
import v, { type V } from "../primitives/v";
import { buildSetUpdate, type SetUpdateSchema } from "./family";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// FILTER TYPES
// =============================================================================

// Similarity operators (l2/cosine) are deliberately absent: the query
// engine rejects them, so the types must not offer them. The PG adapter
// implementations stay reserved for a future opt-in.
type VectorFilterBase<S extends V.Schema> = {
  equals: S;
};

type VectorFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  VectorFilterBase<S>
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildVectorFilterSchema = <S extends V.Schema>(
  schema: S
): VectorFilterSchema<S> => {
  const filter = v.object({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, VectorFilterBase<S>>(filter, schema);
};

// =============================================================================
// VECTOR SCHEMA BUILDER
// =============================================================================

export interface VectorSchemas<F extends ScalarState<"vector">> {
  base: F["base"];
  create: V.Vector<F>;
  update: SetUpdateSchema<F["base"]>;
  filter: VectorFilterSchema<F["base"]>;
}

export const buildVectorSchema = <F extends ScalarState<"vector">>(
  state: F
): VectorSchemas<F> => {
  return lazyScalarSchemas<VectorSchemas<F>>({
    base: state.base,
    create: () => v.vector(undefined, state),
    update: () => buildSetUpdate<F["base"]>(state.base),
    filter: () => buildVectorFilterSchema<F["base"]>(state.base),
  });
};
