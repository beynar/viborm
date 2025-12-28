import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  BaseIntegerSchema,
  BaseNumberSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

// Int uses integer validation
export const intBase = v.integer();
export const intNullable = v.integer({ nullable: true });
export const intList = v.integer({ array: true });
export const intListNullable = v.integer({ array: true, nullable: true });

// Float uses number validation
export const floatBase = v.number();
export const floatNullable = v.number({ nullable: true });
export const floatList = v.number({ array: true });
export const floatListNullable = v.number({ array: true, nullable: true });

// Decimal uses number validation (same as float at runtime)
export const decimalBase = v.number();
export const decimalNullable = v.number({ nullable: true });
export const decimalList = v.number({ array: true });
export const decimalListNullable = v.number({ array: true, nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

// Int filter uses intBase for comparison operations
const intFilterBase = v.object({
  in: intList,
  notIn: intList,
  lt: intBase,
  lte: intBase,
  gt: intBase,
  gte: intBase,
});

const buildIntFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = intFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const intListFilterBase = v.object({
  has: intBase,
  hasEvery: intList,
  hasSome: intList,
  isEmpty: v.boolean(),
});

const buildIntListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = intListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

// Float filter uses floatBase for comparison operations
const floatFilterBase = v.object({
  in: floatList,
  notIn: floatList,
  lt: floatBase,
  lte: floatBase,
  gt: floatBase,
  gte: floatBase,
});

const buildFloatFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = floatFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const floatListFilterBase = v.object({
  has: floatBase,
  hasEvery: floatList,
  hasSome: floatList,
  isEmpty: v.boolean(),
});

const buildFloatListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = floatListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

// =============================================================================
// UPDATE SCHEMAS
// =============================================================================

// Int update with arithmetic operations
const buildIntUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: intBase,
      decrement: intBase,
      multiply: intBase,
      divide: intBase,
    }),
  ]);

const buildIntListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(intBase), intList]),
      unshift: v.union([shorthandArray(intBase), intList]),
    }),
  ]);

// Float update with arithmetic operations
const buildFloatUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      increment: floatBase,
      decrement: floatBase,
      multiply: floatBase,
      divide: floatBase,
    }),
  ]);

const buildFloatListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(floatBase), floatList]),
      unshift: v.union([shorthandArray(floatBase), floatList]),
    }),
  ]);

// =============================================================================
// INT SCHEMA BUILDER
// =============================================================================

export const buildIntSchema = <F extends FieldState<"int">>(state: F) => {
  return {
    base: state.base,
    create: v.integer(state),
    update: state.array
      ? buildIntListUpdateSchema(state.base)
      : buildIntUpdateSchema(state.base),
    filter: state.array
      ? buildIntListFilterSchema(state.base)
      : buildIntFilterSchema(state.base),
  } as IntSchemas<F>;
};

export type IntSchemas<F extends FieldState<"int">> = {
  base: F["base"];
  create: BaseIntegerSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildIntListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildIntUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildIntListFilterSchema<F["base"]>>
    : ReturnType<typeof buildIntFilterSchema<F["base"]>>;
};

export type InferIntInput<
  F extends FieldState<"int">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<IntSchemas<F>[Type]>;

export type InferIntOutput<
  F extends FieldState<"int">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<IntSchemas<F>[Type]>;

// =============================================================================
// FLOAT SCHEMA BUILDER
// =============================================================================

export const buildFloatSchema = <F extends FieldState<"float">>(state: F) => {
  return {
    base: state.base,
    create: v.number(state),
    update: state.array
      ? buildFloatListUpdateSchema(state.base)
      : buildFloatUpdateSchema(state.base),
    filter: state.array
      ? buildFloatListFilterSchema(state.base)
      : buildFloatFilterSchema(state.base),
  } as FloatSchemas<F>;
};

export type FloatSchemas<F extends FieldState<"float">> = {
  base: F["base"];
  create: BaseNumberSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildFloatListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildFloatUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildFloatListFilterSchema<F["base"]>>
    : ReturnType<typeof buildFloatFilterSchema<F["base"]>>;
};

export type InferFloatInput<
  F extends FieldState<"float">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<FloatSchemas<F>[Type]>;

export type InferFloatOutput<
  F extends FieldState<"float">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<FloatSchemas<F>[Type]>;

// =============================================================================
// DECIMAL SCHEMA BUILDER (same as float at runtime)
// =============================================================================

export const buildDecimalSchema = <F extends FieldState<"decimal">>(
  state: F
) => {
  return {
    base: state.base,
    create: v.number(state),
    update: state.array
      ? buildFloatListUpdateSchema(state.base)
      : buildFloatUpdateSchema(state.base),
    filter: state.array
      ? buildFloatListFilterSchema(state.base)
      : buildFloatFilterSchema(state.base),
  } as DecimalSchemas<F>;
};

export type DecimalSchemas<F extends FieldState<"decimal">> = {
  base: F["base"];
  create: BaseNumberSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildFloatListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildFloatUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildFloatListFilterSchema<F["base"]>>
    : ReturnType<typeof buildFloatFilterSchema<F["base"]>>;
};

export type InferDecimalInput<
  F extends FieldState<"decimal">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<DecimalSchemas<F>[Type]>;

export type InferDecimalOutput<
  F extends FieldState<"decimal">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<DecimalSchemas<F>[Type]>;
