import v, {
  type BaseNumberSchema,
  type InferInput,
  type InferOutput,
} from "@validation";
import type { FieldState } from "../common";
import {
  buildFloatFilterSchema,
  buildFloatListFilterSchema,
  buildFloatListUpdateSchema,
  buildFloatUpdateSchema,
  type FloatFilterSchema,
  type FloatListFilterSchema,
  type FloatListUpdateSchema,
  type FloatUpdateSchema,
} from "../float/schemas";

// =============================================================================
// BASE TYPES
// =============================================================================

export const decimalBase = v.number();
export const decimalNullable = v.number({ nullable: true });
export const decimalList = v.number({ array: true });
export const decimalListNullable = v.number({ array: true, nullable: true });

// =============================================================================
// DECIMAL SCHEMA BUILDER (reuses Float types at runtime)
// =============================================================================

export interface DecimalSchemas<F extends FieldState<"decimal">> {
  base: F["base"];
  create: BaseNumberSchema<F>;
  update: F["array"] extends true
    ? FloatListUpdateSchema<F["base"]>
    : FloatUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? FloatListFilterSchema<F["base"]>
    : FloatFilterSchema<F["base"]>;
}

export const buildDecimalSchema = <F extends FieldState<"decimal">>(
  state: F
): DecimalSchemas<F> => {
  return {
    base: state.base as F["base"],
    create: v.number(state),
    update: state.array
      ? buildFloatListUpdateSchema(state.base)
      : buildFloatUpdateSchema(state.base),
    filter: state.array
      ? buildFloatListFilterSchema(state.base)
      : buildFloatFilterSchema(state.base),
  } as DecimalSchemas<F>;
};

export type InferDecimalInput<
  F extends FieldState<"decimal">,
  Type extends keyof DecimalSchemas<F>,
> = InferInput<DecimalSchemas<F>[Type]>;

export type InferDecimalOutput<
  F extends FieldState<"decimal">,
  Type extends keyof DecimalSchemas<F>,
> = InferOutput<DecimalSchemas<F>[Type]>;
