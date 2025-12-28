import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  array,
  BaseEnumSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";
import { EnumValues } from "../../../validation/schemas/enum";

const enumBase = <Values extends string[]>(values: Values) => v.enum(values);

const enumList = <Values extends string[]>(values: Values) =>
  v.enum(values, { array: true });

const buildEnumFilterSchema = <S extends VibSchema, Values extends string[]>(
  schema: S,
  values: Values
) => {
  const list = enumList(values);
  const filter = v.object({
    equals: schema,
    in: list,
    notIn: list,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const buildEnumListFilterSchema = <
  S extends VibSchema,
  Values extends string[]
>(
  schema: S,
  values: Values
) => {
  const base = enumBase(values);
  const list = enumList(values);
  const enumListFilterBase = v.object({
    has: base,
    hasEvery: list,
    hasSome: list,
    isEmpty: v.boolean(),
  });

  const filter = enumListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildEnumUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildEnumListUpdateSchema = <
  S extends VibSchema,
  Values extends string[]
>(
  schema: S,
  values: Values
) => {
  const base = enumBase(values);
  const list = enumList(values);
  return v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(base), list]),
      unshift: v.union([shorthandArray(base), list]),
    }),
  ]);
};

export const buildEnumSchema = <
  Values extends string[],
  F extends FieldState<"enum">
>(
  values: Values,
  state: F
) => {
  return {
    base: state.base,
    create: v.enum(values, state),
    update: state.array
      ? buildEnumListUpdateSchema(state.base, values)
      : buildEnumUpdateSchema(state.base),
    filter: state.array
      ? buildEnumListFilterSchema(state.base, values)
      : buildEnumFilterSchema(state.base, values),
  } as EnumSchemas<Values, F>;
};

export type EnumSchemas<
  Values extends string[],
  F extends FieldState<"enum">
> = {
  base: F["base"];
  create: BaseEnumSchema<Values, F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildEnumListUpdateSchema<F["base"], Values>>
    : ReturnType<typeof buildEnumUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildEnumListFilterSchema<F["base"], Values>>
    : ReturnType<typeof buildEnumFilterSchema<F["base"], Values>>;
};

export type InferEnumInput<
  F extends FieldState<"enum">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<EnumSchemas<EnumValues<F["base"]>, F>[Type]>;

export type InferEnumOutput<
  F extends FieldState<"enum">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<EnumSchemas<EnumValues<F["base"]>, F>[Type]>;
