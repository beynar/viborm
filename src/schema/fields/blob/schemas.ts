import { FieldState, shorthandFilter, shorthandUpdate } from "../common";
import v, {
  BaseBlobSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const blobBase = v.blob();
export const blobNullable = v.blob({ nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const buildBlobFilterSchema = <S extends VibSchema>(schema: S) => {
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

const buildBlobUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

export const buildBlobSchema = <F extends FieldState<"blob">>(state: F) => {
  return {
    base: state.base,
    create: v.blob(state),
    update: buildBlobUpdateSchema(state.base),
    filter: buildBlobFilterSchema(state.base),
  } as BlobSchemas<F>;
};

type BlobSchemas<F extends FieldState<"blob">> = {
  base: F["base"];
  create: BaseBlobSchema<F>;
  update: ReturnType<typeof buildBlobUpdateSchema<F["base"]>>;
  filter: ReturnType<typeof buildBlobFilterSchema<F["base"]>>;
};

export type InferBlobInput<
  F extends FieldState<"blob">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<BlobSchemas<F>[Type]>;

export type InferBlobOutput<
  F extends FieldState<"blob">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<BlobSchemas<F>[Type]>;
