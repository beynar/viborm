import v, {
  type BaseVectorSchema,
  type InferInput,
  type InferOutput,
  type VibSchema,
} from "@validation";
import { type FieldState, shorthandUpdate } from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const vectorBase = v.vector();
export const vectorNullable = v.vector(undefined, { nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================
const shorthandFilterVector = <S extends VibSchema>(schema: S) =>
  v.coerce(schema, (val: S[" vibInferred"]["0"]) => ({ cosine: val }));

const buildVectorFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = v.object({
    l2: schema,
    cosine: schema,
  });
  return v.union([shorthandFilterVector(schema), filter]);
};

const buildVectorUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

export const buildVectorSchema = <F extends FieldState<"vector">>(state: F) => {
  return {
    base: state.base,
    create: v.vector(undefined, state),
    update: buildVectorUpdateSchema(state.base),
    filter: buildVectorFilterSchema(state.base),
  } as VectorSchemas<F>;
};

export type VectorSchemas<F extends FieldState<"vector">> = {
  base: F["base"];
  create: BaseVectorSchema<F>;
  update: ReturnType<typeof buildVectorUpdateSchema<F["base"]>>;
  filter: ReturnType<typeof buildVectorFilterSchema<F["base"]>>;
};

export type InferVectorInput<
  F extends FieldState<"vector">,
  Type extends "create" | "update" | "filter" | "base",
> = InferInput<VectorSchemas<F>[Type]>;

export type InferVectorOutput<
  F extends FieldState<"vector">,
  Type extends "create" | "update" | "filter" | "base",
> = InferOutput<VectorSchemas<F>[Type]>;
