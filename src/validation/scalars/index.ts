/**
 * Scalar Schemas
 *
 * Validation schemas for create, update, and filter operations on all scalar types.
 */

import type { AnyModel } from "@schema/model";
import type { ScalarState } from "@schema/scalars";
import type { EnumValues } from "@validation/primitives/enum";
import type { OperandCtx } from "@validation/primitives/operand";
import { lazyRecord } from "../lazy";
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
export { buildDecimalSchema, type DecimalSchemas } from "./decimal";
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

export const getScalarSchemas = <F extends ScalarState>(
  scalar: F
): GetScalarSchemas<F> => {
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
        scalar as ScalarState<"string">
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
export const getScalarsSchemas = <Source extends AnyModel>(source: Source) => {
  // Build each field's schemas lazily: a field's create/update/filter schemas
  // are only constructed when that field is first referenced (e.g. via
  // `v.fromObject(scalars, "filter")` reading `scalars[field].filter`). This
  // keeps `buildModelSchemas` — which runs on the first query per model per
  // isolate — from eagerly materializing every field's validators up front.
  const builders: Record<string, () => unknown> = {};
  const scalars = source["~"].state.scalars;
  for (const scalar in scalars) {
    const state = scalars[scalar]!["~"].state;
    builders[scalar] = () => getScalarSchemas(state);
  }
  return lazyRecord(builders) as GetScalarsSchemas<Source>;
};

export type GetScalarsSchemas<Source extends AnyModel> = {
  [F in keyof Source["~"]["state"]["scalars"]]: GetScalarSchemas<
    Source["~"]["state"]["scalars"][F]["~"]["state"],
    OperandCtx<Source>
  >;
};
