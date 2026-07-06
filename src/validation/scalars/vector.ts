import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";

// =============================================================================
// FILTER TYPES
// =============================================================================

// Similarity operators (l2/cosine) are deliberately absent: the query
// engine rejects them, so the types must not offer them. The PG adapter
// implementations stay reserved for a future opt-in.
type VectorFilterBase<S extends V.Schema> = {
  equals: S;
};

type VectorFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      VectorFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<VectorFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type VectorUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
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
  return v.union([
    v.shorthandFilter(schema),
    filter.extend({
      not: v.union([v.shorthandFilter(schema), filter]),
    }),
  ]);
};

const buildVectorUpdateSchema = <S extends V.Schema>(
  schema: S
): VectorUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

// =============================================================================
// VECTOR SCHEMA BUILDER
// =============================================================================

export interface VectorSchemas<F extends ScalarState<"vector">> {
  base: F["base"];
  create: V.Vector<F>;
  update: VectorUpdateSchema<F["base"]>;
  filter: VectorFilterSchema<F["base"]>;
}

export const buildVectorSchema = <F extends ScalarState<"vector">>(
  state: F
): VectorSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.vector(undefined, state),
    update: buildVectorUpdateSchema(state.base),
    filter: buildVectorFilterSchema(state.base),
  } as VectorSchemas<F>;
};
