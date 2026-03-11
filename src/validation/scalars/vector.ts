import type { FieldState } from "@schema/fields/common";
import v, { type V } from "@validation";

// =============================================================================
// FILTER TYPES
// =============================================================================

type VectorFilterBase<S extends V.Schema> = {
  l2: S;
  cosine: S;
};

type VectorFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.Coerce<S, { cosine: S[" vibInferred"]["1"] }>,
    V.Object<VectorFilterBase<S>>,
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

const shorthandFilterVector = <S extends V.Schema>(schema: S) =>
  v.coerce(schema, (val: S[" vibInferred"]["0"]) => ({ cosine: val }));

const buildVectorFilterSchema = <S extends V.Schema>(
  schema: S
): VectorFilterSchema<S> => {
  const filter = v.object({
    l2: schema,
    cosine: schema,
  });
  return v.union([shorthandFilterVector(schema), filter]);
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

export interface VectorSchemas<F extends FieldState<"vector">> {
  base: F["base"];
  create: V.Vector<F>;
  update: VectorUpdateSchema<F["base"]>;
  filter: VectorFilterSchema<F["base"]>;
}

export const buildVectorSchema = <F extends FieldState<"vector">>(
  state: F
): VectorSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.vector(undefined, state),
    update: buildVectorUpdateSchema(state.base),
    filter: buildVectorFilterSchema(state.base),
  } as VectorSchemas<F>;
};
