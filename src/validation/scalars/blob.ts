import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// =============================================================================
// FILTER TYPES
// =============================================================================

type BlobFilterBase<S extends V.Schema> = {
  equals: S;
};

type BlobFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  BlobFilterBase<S>
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

type BlobUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

const buildBlobFilterSchema = <S extends V.Schema>(
  schema: S
): BlobFilterSchema<S> => {
  const filter = v.object({
    equals: schema,
  });
  return buildNegatableFilterSchema<S, BlobFilterBase<S>>(filter, schema);
};

const buildBlobUpdateSchema = <S extends V.Schema>(
  schema: S
): BlobUpdateSchema<S> =>
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
// BLOB SCHEMA BUILDER
// =============================================================================

export interface BlobSchemas<F extends ScalarState<"blob">> {
  base: F["base"];
  create: V.Blob<F>;
  update: BlobUpdateSchema<F["base"]>;
  filter: BlobFilterSchema<F["base"]>;
}

export const buildBlobSchema = <F extends ScalarState<"blob">>(
  state: F
): BlobSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.blob(state),
    update: buildBlobUpdateSchema(state.base),
    filter: buildBlobFilterSchema(state.base),
  } as BlobSchemas<F>;
};
