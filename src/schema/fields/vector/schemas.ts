import v, {
  type BaseVectorSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import { type FieldState, shorthandUpdate } from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const vectorBase = v.vector();
export const vectorNullable = v.vector(undefined, { nullable: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type VectorFilterBase<S extends V.Schema> = {
  l2: S;
  cosine: S;
};

export type VectorFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.Coerce<S, { cosine: S[" vibInferred"]["1"] }>,
    V.Object<VectorFilterBase<S>>,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

export type VectorUpdateSchema<S extends V.Schema> = V.Union<
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
    shorthandUpdate(schema),
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
  create: BaseVectorSchema<F>;
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

export type InferVectorInput<
  F extends FieldState<"vector">,
  Type extends keyof VectorSchemas<F>,
> = InferInput<VectorSchemas<F>[Type]>;

export type InferVectorOutput<
  F extends FieldState<"vector">,
  Type extends keyof VectorSchemas<F>,
> = InferOutput<VectorSchemas<F>[Type]>;
