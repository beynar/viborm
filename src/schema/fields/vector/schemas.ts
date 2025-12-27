import { FieldState, shorthandFilter, shorthandUpdate } from "../common";
import v, {
  BaseVectorSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const vectorBase = v.vector();
export const vectorNullable = v.vector(undefined, { nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const buildVectorFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = v.object({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
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

type VectorSchemas<F extends FieldState<"vector">> = {
  base: F["base"];
  create: BaseVectorSchema<F>;
  update: ReturnType<typeof buildVectorUpdateSchema<F["base"]>>;
  filter: ReturnType<typeof buildVectorFilterSchema<F["base"]>>;
};

export type InferVectorInput<
  F extends FieldState<"vector">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<VectorSchemas<F>[Type]>;

export type InferVectorOutput<
  F extends FieldState<"vector">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<VectorSchemas<F>[Type]>;
