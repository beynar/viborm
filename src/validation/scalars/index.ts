/**
 * Scalar Schemas
 *
 * Validation schemas for create, update, and filter operations on all scalar types.
 */

import type { FieldState } from "@schema/fields";
import type { AnyModel } from "@schema/model";
import type { EnumValues } from "@validation/primitives/enum";
import { type BigIntSchemas, buildBigIntSchema } from "./bigint";
import { type BlobSchemas, buildBlobSchema } from "./blob";
import { type BooleanSchemas, buildBooleanSchema } from "./boolean";
import { buildDateSchema, type DateSchemas } from "./date";
import { buildDateTimeSchema, type DateTimeSchemas } from "./datetime";
import { buildDecimalSchema, type DecimalSchemas } from "./decimal";
import { buildEnumSchema, type EnumSchemas } from "./enum";
import { buildFloatSchema, type FloatSchemas } from "./float";
import { buildIntSchema, type IntSchemas } from "./int";
import { buildJsonSchema, type JsonSchemas } from "./json";
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
export { buildFloatSchema, type FloatSchemas } from "./float";
export { buildIntSchema, type IntSchemas } from "./int";
export { buildJsonSchema, type JsonSchemas } from "./json";
export { buildPointSchema, type PointSchemas } from "./point";
export { buildStringSchema, type StringSchemas } from "./string";
export { buildTimeSchema, type TimeSchemas } from "./time";
export { buildVectorSchema, type VectorSchemas } from "./vector";

export type GetScalarSchemas<F extends FieldState> =
  F extends FieldState<"bigint">
    ? BigIntSchemas<F>
    : F extends FieldState<"blob">
      ? BlobSchemas<F>
      : F extends FieldState<"boolean">
        ? BooleanSchemas<F>
        : F extends FieldState<"datetime">
          ? DateTimeSchemas<F>
          : F extends FieldState<"decimal">
            ? DecimalSchemas<F>
            : F extends FieldState<"enum">
              ? EnumSchemas<EnumValues<F["base"]>, F>
              : F extends FieldState<"float">
                ? FloatSchemas<F>
                : F extends FieldState<"int">
                  ? IntSchemas<F>
                  : F extends FieldState<"json">
                    ? JsonSchemas<F>
                    : F extends FieldState<"point">
                      ? PointSchemas<F>
                      : F extends FieldState<"string">
                        ? StringSchemas<F>
                        : F extends FieldState<"vector">
                          ? VectorSchemas<F>
                          : F extends FieldState<"date">
                            ? DateSchemas<F>
                            : F extends FieldState<"time">
                              ? TimeSchemas<F>
                              : never;

export const getScalarSchemas = <F extends FieldState>(
  scalar: F
): GetScalarSchemas<F> => {
  switch (scalar.type) {
    case "bigint":
      return buildBigIntSchema(
        scalar as FieldState<"bigint">
      ) as GetScalarSchemas<F>;
    case "blob":
      return buildBlobSchema(
        scalar as FieldState<"blob">
      ) as GetScalarSchemas<F>;
    case "boolean":
      return buildBooleanSchema(
        scalar as FieldState<"boolean">
      ) as GetScalarSchemas<F>;
    case "datetime":
      return buildDateTimeSchema(
        scalar as FieldState<"datetime">
      ) as GetScalarSchemas<F>;
    case "decimal":
      return buildDecimalSchema(
        scalar as FieldState<"decimal">
      ) as GetScalarSchemas<F>;
    case "enum":
      return buildEnumSchema(
        scalar as FieldState<"enum">
      ) as GetScalarSchemas<F>;
    case "float":
      return buildFloatSchema(
        scalar as FieldState<"float">
      ) as GetScalarSchemas<F>;
    case "int":
      return buildIntSchema(scalar as FieldState<"int">) as GetScalarSchemas<F>;
    case "json":
      return buildJsonSchema(
        scalar as FieldState<"json">
      ) as GetScalarSchemas<F>;
    case "point":
      return buildPointSchema(
        scalar as FieldState<"point">
      ) as GetScalarSchemas<F>;
    case "string":
      return buildStringSchema(
        scalar as FieldState<"string">
      ) as GetScalarSchemas<F>;
    case "vector":
      return buildVectorSchema(
        scalar as FieldState<"vector">
      ) as GetScalarSchemas<F>;
    case "date":
      return buildDateSchema(
        scalar as FieldState<"date">
      ) as GetScalarSchemas<F>;
    case "time":
      return buildTimeSchema(
        scalar as FieldState<"time">
      ) as GetScalarSchemas<F>;
    default:
      throw new Error(`Unknown scalar type: ${scalar.type}`);
  }
};

/**
 * Get all scalars schemas for a given model
 */
export const getScalarsSchemas = <Source extends AnyModel>(source: Source) => {
  const scalarsSchemas: Record<string, unknown> = {};
  const scalars = source["~"].state.scalars;
  for (const scalar in scalars) {
    const state = scalars[scalar]!["~"].state;
    Object.assign(scalarsSchemas, {
      [scalar]: getScalarSchemas(state),
    });
  }
  return scalarsSchemas as GetScalarsSchemas<Source>;
};

export type GetScalarsSchemas<Source extends AnyModel> = {
  [F in keyof Source["~"]["state"]["scalars"]]: GetScalarSchemas<
    Source["~"]["state"]["scalars"][F]["~"]["state"]
  >;
};
