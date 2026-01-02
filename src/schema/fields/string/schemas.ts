import {
  FieldState,
  shorthandFilter,
  shorthandUpdate,
  shorthandArray,
} from "../common";
import v, {
  BaseStringSchema,
  InferInput,
  InferOutput,
  VibSchema,
} from "@validation";

// =============================================================================
// BASE TYPES
// =============================================================================

export const stringBase = v.string();
export const stringNullable = v.string({ nullable: true });
export const stringList = v.string({ array: true });
export const stringListNullable = v.string({ array: true, nullable: true });

// =============================================================================
// FILTER SCHEMAS
// =============================================================================

const stringFilterBase = v.object({
  in: stringList,
  notIn: stringList,
  contains: stringBase,
  startsWith: stringBase,
  endsWith: stringBase,
  mode: v.enum(["default", "insensitive"]),
});

const buildStringFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = stringFilterBase.extend({
    equals: schema,
    lt: schema,
    lte: schema,
    gt: schema,
    gte: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({
      not: v.union([shorthandFilter(schema), filter]),
    }),
  ]);
};

const stringListFilterBase = v.object({
  has: stringBase,
  hasEvery: stringList,
  hasSome: stringList,
  isEmpty: v.boolean(),
});
const buildStringListFilterSchema = <S extends VibSchema>(schema: S) => {
  const filter = stringListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

const buildStringUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object(
      {
        set: schema,
      },
      { partial: false }
    ),
  ]);

const buildStringListUpdateSchema = <S extends VibSchema>(schema: S) =>
  v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(stringBase), stringList]),
      unshift: v.union([shorthandArray(stringBase), stringList]),
    }),
  ]);

export const buildStringSchema = <F extends FieldState<"string">>(state: F) => {
  return {
    base: state.base as F["base"],
    create: v.string(state),
    update: state.array
      ? buildStringListUpdateSchema(state.base)
      : buildStringUpdateSchema(state.base),
    filter: state.array
      ? buildStringListFilterSchema(state.base)
      : buildStringFilterSchema(state.base),
  } as StringSchemas<F>;
};

export type StringSchemas<F extends FieldState<"string">> = {
  base: F["base"];
  create: BaseStringSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildStringListUpdateSchema<F["base"]>>
    : ReturnType<typeof buildStringUpdateSchema<F["base"]>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildStringListFilterSchema<F["base"]>>
    : ReturnType<typeof buildStringFilterSchema<F["base"]>>;
};

export type InferStringInput<
  F extends FieldState<"string">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<StringSchemas<F>[Type]>;

export type InferStringOutput<
  F extends FieldState<"string">,
  Type extends "create" | "update" | "filter" | "base"
> = InferOutput<StringSchemas<F>[Type]>;
