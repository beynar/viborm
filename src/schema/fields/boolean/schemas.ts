import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  BaseBooleanSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "../../../validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const booleanBase = v.boolean();
export const booleanNullable = v.boolean({ nullable: true });
export const booleanList = v.boolean({ array: true });
export const booleanListNullable = v.boolean({ array: true, nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const booleanFilterBase = v.object({
  equals: booleanBase,
});

const buildBooleanFilterSchema = <S extends VibSchema>(schema: S) => {
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

const booleanListFilterBase = v.object({
  has: booleanBase,
  hasEvery: booleanList,
  hasSome: booleanList,
  isEmpty: v.boolean(),
});

const buildBooleanListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = booleanListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildBooleanUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildBooleanListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(booleanBase), booleanList]),
      unshift: v.union([shorthandArray(booleanBase), booleanList]),
    }),
  ]);

export const buildBooleanSchema = <F extends FieldState<"boolean">>(
  state: F
) => {
  return {
    base: state.base,
    create: v.boolean(state),
    update: state.array
      ? buildBooleanListUpdateSchema(state.base)
      : buildBooleanUpdateSchema(state.base),
    filter: state.array
      ? buildBooleanListFilterSchema(state.base)
      : buildBooleanFilterSchema(state.base),
  } as BooleanSchemas<F>;
};

type BooleanSchemas<F extends FieldState<"boolean">> = {
  base: F["base"];
  create: BaseBooleanSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildBooleanListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildBooleanUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildBooleanListFilterSchema<F["base"]>>
    : ReturnType<typeof buildBooleanFilterSchema<F["base"]>>;
};

export type InferBooleanInput<
  F extends FieldState<"boolean">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<BooleanSchemas<F>[Type]>;

export type InferBooleanOutput<
  F extends FieldState<"boolean">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<BooleanSchemas<F>[Type]>;
