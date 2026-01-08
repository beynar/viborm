import v, {
  type BaseBlobSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { V } from "@validation/V";
import { type FieldState, shorthandFilter, shorthandUpdate } from "../common";

// =============================================================================
// BASE TYPES
// =============================================================================

export const blobBase = v.blob();
export const blobNullable = v.blob({ nullable: true });

// =============================================================================
// FILTER TYPES
// =============================================================================

type BlobFilterBase<S extends V.Schema> = {
  equals: S;
};

export type BlobFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      BlobFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<BlobFilterBase<S>>]
        >;
      }
    >,
  ]
>;

// =============================================================================
// UPDATE TYPES
// =============================================================================

export type BlobUpdateSchema<S extends V.Schema> = V.Union<
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
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const buildBlobUpdateSchema = <S extends V.Schema>(
  schema: S
): BlobUpdateSchema<S> =>
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
// BLOB SCHEMA BUILDER
// =============================================================================

export interface BlobSchemas<F extends FieldState<"blob">> {
  base: F["base"];
  create: BaseBlobSchema<F>;
  update: BlobUpdateSchema<F["base"]>;
  filter: BlobFilterSchema<F["base"]>;
}

export const buildBlobSchema = <F extends FieldState<"blob">>(
  state: F
): BlobSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.blob(state),
    update: buildBlobUpdateSchema(state.base),
    filter: buildBlobFilterSchema(state.base),
  } as BlobSchemas<F>;
};

export type InferBlobInput<
  F extends FieldState<"blob">,
  Type extends keyof BlobSchemas<F>,
> = InferInput<BlobSchemas<F>[Type]>;

export type InferBlobOutput<
  F extends FieldState<"blob">,
  Type extends keyof BlobSchemas<F>,
> = InferOutput<BlobSchemas<F>[Type]>;
