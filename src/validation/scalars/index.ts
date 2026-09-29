/**
 * Scalar Schemas
 *
 * Validation schemas for create, update, and filter operations on all scalar types.
 */

import type { AnyModel } from "@schema/model";
import type { ScalarState } from "@schema/scalars";
import {
  currentTemporalValue,
  type TemporalKind,
} from "@schema/scalars/datetime/current";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { inferred } from "@validation/inferred";
import type { EnumValues } from "@validation/primitives/enum";
import { createSchema, validateSchema } from "@validation/primitives/helpers";
import type { IdDomain } from "@validation/primitives/id-codec";
import type { OperandCtx } from "@validation/primitives/operand";
import type { VibSchema } from "@validation/types";
import {
  lazyRecord,
  lazyScalarSchemas,
  type ScalarVariantSchemas,
} from "../lazy";
import { type BigIntSchemas, buildBigIntSchema } from "./bigint";
import { type BlobSchemas, buildBlobSchema } from "./blob";
import { type BooleanSchemas, buildBooleanSchema } from "./boolean";
import { buildDateSchema, type DateSchemas } from "./date";
import { buildDateTimeSchema, type DateTimeSchemas } from "./datetime";
import { buildDecimalSchema, type DecimalSchemas } from "./decimal";
import { buildEnumSchema, type EnumSchemas } from "./enum";
import { buildIntSchema, type IntSchemas } from "./int";
import { buildJsonSchema, type JsonSchemas } from "./json";
import { buildNumberSchema, type NumberSchemas } from "./number";
import { buildPointSchema, type PointSchemas } from "./point";
import { buildStringSchema, type StringSchemas } from "./string";
import { buildTimeSchema, type TimeSchemas } from "./time";
import { buildVectorSchema, type VectorSchemas } from "./vector";

// Re-export only the build functions and schema interfaces
export { type BigIntSchemas, buildBigIntSchema } from "./bigint";
export { type BlobSchemas, buildBlobSchema } from "./blob";
export { type BooleanSchemas, buildBooleanSchema } from "./boolean";
export { buildDateSchema, type DateSchemas } from "./date";
export { buildDateTimeSchema, type DateTimeSchemas } from "./datetime";
export {
  buildDecimalSchema,
  type DecimalSchemas,
  type DecimalUpdateOperationKeys,
} from "./decimal";
export { buildEnumSchema, type EnumSchemas } from "./enum";
export { buildIntSchema, type IntSchemas } from "./int";
export { buildJsonSchema, type JsonSchemas } from "./json";
export { buildNumberSchema, type NumberSchemas } from "./number";
export { buildPointSchema, type PointSchemas } from "./point";
export { buildStringSchema, type StringSchemas } from "./string";
export { buildTimeSchema, type TimeSchemas } from "./time";
export { buildVectorSchema, type VectorSchemas } from "./vector";

/**
 * `C` is the operand-callback context of the model these schemas belong to —
 * `{ fields, sql }` keyed to that model's scalars. It is threaded at the TYPE
 * level only: at runtime the filter schemas stay model-blind and interned
 * across models (see `intern.ts`), and a callback resolves its context from the
 * model scope the `where` schema pushes (see `primitives/operand.ts`). Types are
 * erased, so per-model operand types cost the runtime nothing.
 */
export type GetScalarSchemas<
  F extends ScalarState,
  C extends OperandCtx<any> = OperandCtx<any>,
> = F extends ScalarState<"bigint">
  ? BigIntSchemas<F, C>
  : F extends ScalarState<"blob">
    ? BlobSchemas<F>
    : F extends ScalarState<"boolean">
      ? BooleanSchemas<F, C>
      : F extends ScalarState<"datetime">
        ? DateTimeSchemas<F, C>
        : F extends ScalarState<"decimal">
          ? DecimalSchemas<F, C>
          : F extends ScalarState<"enum">
            ? EnumSchemas<EnumValues<F["base"]>, F, C>
            : F extends ScalarState<"int">
              ? IntSchemas<F, C>
              : F extends ScalarState<"json">
                ? JsonSchemas<F>
                : F extends ScalarState<"number">
                  ? NumberSchemas<F, C>
                  : F extends ScalarState<"point">
                    ? PointSchemas<F>
                    : F extends ScalarState<"string">
                      ? StringSchemas<F, C>
                      : F extends ScalarState<"vector">
                        ? VectorSchemas<F>
                        : F extends ScalarState<"date">
                          ? DateSchemas<F, C>
                          : F extends ScalarState<"time">
                            ? TimeSchemas<F, C>
                            : never;

/**
 * `derived` is the identifier domain a FOREIGN-KEY member inherits from the key
 * it references. Only a string scalar can have one, and only when it declares
 * none of its own — an FK that declares a domain disagreeing with its target is
 * refused before any schema is built.
 */
export const getScalarSchemas = <F extends ScalarState>(
  scalar: F,
  derived?: IdDomain
): GetScalarSchemas<F> => {
  // biome-ignore lint/style/useDefaultSwitchClause: ScalarState.type makes this switch exhaustive.
  switch (scalar.type) {
    case "bigint":
      return buildBigIntSchema(
        scalar as ScalarState<"bigint">
      ) as GetScalarSchemas<F>;
    case "blob":
      return buildBlobSchema(
        scalar as ScalarState<"blob">
      ) as GetScalarSchemas<F>;
    case "boolean":
      return buildBooleanSchema(
        scalar as ScalarState<"boolean">
      ) as GetScalarSchemas<F>;
    case "datetime":
      return buildDateTimeSchema(
        scalar as ScalarState<"datetime">
      ) as GetScalarSchemas<F>;
    case "decimal":
      return buildDecimalSchema(
        scalar as ScalarState<"decimal">
      ) as GetScalarSchemas<F>;
    case "enum":
      return buildEnumSchema(
        scalar as ScalarState<"enum">
      ) as GetScalarSchemas<F>;
    case "int":
      return buildIntSchema(
        scalar as ScalarState<"int">
      ) as GetScalarSchemas<F>;
    case "json":
      return buildJsonSchema(
        scalar as ScalarState<"json">
      ) as GetScalarSchemas<F>;
    case "number":
      return buildNumberSchema(
        scalar as ScalarState<"number">
      ) as GetScalarSchemas<F>;
    case "point":
      return buildPointSchema(
        scalar as ScalarState<"point">
      ) as GetScalarSchemas<F>;
    case "string":
      return buildStringSchema(
        scalar as ScalarState<"string">,
        derived
      ) as GetScalarSchemas<F>;
    case "vector":
      return buildVectorSchema(
        scalar as ScalarState<"vector">
      ) as GetScalarSchemas<F>;
    case "date":
      return buildDateSchema(
        scalar as ScalarState<"date">
      ) as GetScalarSchemas<F>;
    case "time":
      return buildTimeSchema(
        scalar as ScalarState<"time">
      ) as GetScalarSchemas<F>;
  }
};

/**
 * Get all scalars schemas for a given model
 */
export const getScalarsSchemas = <Source extends AnyModel>(
  source: Source,
  derived?: ReadonlyMap<string, IdDomain>
) => {
  // Build each field's schemas lazily: a field's create/update/filter schemas
  // are only constructed when that field is first referenced (e.g. via
  // `v.fromObject(scalars, "filter")` reading `scalars[field].filter`). This
  // keeps `buildModelSchemas` — which runs on the first query per model per
  // isolate — from eagerly materializing every field's validators up front.
  const builders: Record<string, () => unknown> = {};
  const scalars = source["~"].state.scalars;
  for (const scalar in scalars) {
    const state = scalars[scalar]!["~"].state;
    builders[scalar] = () => {
      const schemas = getScalarSchemas(state, derived?.get(scalar));
      if (state.autoGenerate?.kind === "now") return insertOnly(schemas);
      if (state.autoGenerate?.kind === "updatedAt" && !state.array)
        return updatesAt(schemas, state.type);
      return schemas;
    };
  }
  return lazyRecord(builders) as GetScalarsSchemas<Source>;
};

/**
 * A `.now()` creation timestamp is INSERT-ONLY: its record keeps `base`,
 * `create` and `filter`, and its `update` is `undefined`.
 *
 * The rule is read here, once per model field, from the field's EFFECTIVE
 * generator: `autoGenerate` is the declaration standing after every modifier,
 * so `.now().updatedAt()` stays updatable, `.updatedAt().now()` does not, and a
 * modifier that keeps the generator (`.nullable()`, `.map()`, `.default(v)`)
 * keeps the restriction. `.default(v)` alone declares no generator.
 *
 * Omission is the whole mechanism. `fromObject(scalars, "update")` builds no
 * entry for an `undefined` member, so the strict update object refuses the key
 * as `Unknown key` — beside a valid key, inside `{ set }`, and spelled
 * `undefined`, which a present entry would skip as absent — and the kind's
 * interned value validators are never consulted, so access order between two
 * fields with the same flags cannot hand one the other's permission.
 *
 * It restricts what the typed ORM assigns, not the column: raw SQL, other
 * writers and database cascades are not blocked.
 */
const insertOnly = <T extends object>(schemas: T): T =>
  Object.defineProperty(schemas, "update", {
    value: undefined,
    enumerable: true,
  });

type DefaultedUpdate<Input, Output> = VibSchema<Input | undefined, Output> & {
  readonly acceptsUndefined: true;
};

/**
 * Give one field's update schema its `.updatedAt()` omission default without
 * putting field-specific state into the kind-wide update interner.
 *
 * The wrapper is the admission lifetime: every missing field occurrence reads
 * the wall clock once, then passes that value through the same update schema as
 * an explicit value. The shorthand arm therefore validates and normalizes it
 * into `{ set: value }` exactly once. A caller-supplied value bypasses the
 * clock, and a replay of admitted data never reaches this wrapper again.
 */
const updatedAtUpdate = <S extends VibSchema>(
  update: S,
  kind: TemporalKind
): DefaultedUpdate<
  StandardSchemaV1.InferInput<S>,
  StandardSchemaV1.InferOutput<S>
> => {
  const metadata = {
    acceptsUndefined: true,
    wrapped: update,
  } satisfies {
    readonly acceptsUndefined: true;
    readonly wrapped: S;
  };
  return Object.assign(
    createSchema<
      StandardSchemaV1.InferInput<S> | undefined,
      StandardSchemaV1.InferOutput<S>
    >("optional", (value) =>
      validateSchema(
        update,
        value === undefined ? currentTemporalValue(kind) : value
      )
    ),
    metadata
  );
};

type UpdatedAtSchemas<Base, Create, Input, Output, Filter> = {
  readonly base: Base;
  readonly create: Create;
  readonly update: DefaultedUpdate<Input, Output>;
  readonly filter: Filter;
};

type UpdatedAtSchemasOf<
  T extends ScalarVariantSchemas & { readonly update: VibSchema },
> = UpdatedAtSchemas<
  T["base"],
  T["create"],
  StandardSchemaV1.InferInput<T["update"]>,
  StandardSchemaV1.InferOutput<T["update"]>,
  T["filter"]
>;

const updatesAt = <
  T extends ScalarVariantSchemas & { readonly update: VibSchema },
>(
  schemas: T,
  kind: TemporalKind
): UpdatedAtSchemasOf<T> =>
  lazyScalarSchemas<UpdatedAtSchemasOf<T>>({
    base: schemas.base,
    create: () => schemas.create,
    update: () => updatedAtUpdate(schemas.update, kind),
    filter: () => schemas.filter,
  });

/**
 * The type half of {@link insertOnly}. Its `update` is `undefined`, which
 * `V.FromObject` turns into a `never` entry: the update input still NAMES the
 * key, as `?: never`, so a payload held in a variable is refused too — a key
 * that is merely absent refuses only a fresh literal.
 *
 * It is also the type half of {@link updatesAt}. That arm destructures the
 * record by `infer` and reads the update schema's input and output from its
 * `[inferred]` brand, the channel `InferInput`/`InferOutput` already read.
 * Asking instead whether the record `extends ScalarVariantSchemas & { update:
 * VibSchema }` relates every field's update schema to `VibSchema`
 * structurally, once per field per model and again inside every generic body
 * that reaches this alias: it raised the instrumentation layer's type program
 * from 0.91M to 1.38M types (4.9M to 7.6M instantiations) and out of its
 * 1280 MB shard heap. The record this arm yields is pinned in
 * `tests/types/operation-schemas/updated-at.core.types.ts`.
 */
type UpdateAdmission<Schemas, State> = State extends {
  readonly autoGenerate: { readonly kind: "now" };
}
  ? Omit<Schemas, "update"> & { readonly update: undefined }
  : State extends { readonly array: true }
    ? Schemas
    : State extends {
          readonly autoGenerate: { readonly kind: "updatedAt" };
        }
      ? Schemas extends {
          readonly base: infer Base;
          readonly create: infer Create;
          readonly update: { readonly [inferred]: [infer Input, infer Output] };
          readonly filter: infer Filter;
        }
        ? UpdatedAtSchemas<Base, Create, Input, Output, Filter>
        : Schemas
      : Schemas;

export type GetScalarsSchemas<Source extends AnyModel> = {
  [F in keyof Source["~"]["state"]["scalars"]]: UpdateAdmission<
    GetScalarSchemas<
      Source["~"]["state"]["scalars"][F]["~"]["state"],
      OperandCtx<Source>
    >,
    Source["~"]["state"]["scalars"][F]["~"]["state"]
  >;
};
