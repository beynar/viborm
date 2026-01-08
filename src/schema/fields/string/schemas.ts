import v, { type InferInput, type InferOutput } from "@validation";
import type { V } from "@validation/V";
import {
  type FieldState,
  shorthandArray,
  shorthandFilter,
  shorthandUpdate,
} from "../common";

// Base schemas
export const stringBase = v.string();
export const stringNullable = v.string({ nullable: true });
export const stringList = v.string({ array: true });
export const stringListNullable = v.string({ array: true, nullable: true });

// Internal filter base
const stringFilterBase = v.object({
  in: stringList,
  notIn: stringList,
  contains: stringBase,
  startsWith: stringBase,
  endsWith: stringBase,
  mode: v.enum(["default", "insensitive"]),
});

type StringFilterBase<S extends V.Schema> = {
  equals: S;
  lt: S;
  lte: S;
  gt: S;
  gte: S;
  in: V.String<{ array: true }>;
  notIn: V.String<{ array: true }>;
  contains: V.String;
  startsWith: V.String;
  endsWith: V.String;
  mode: V.Enum<["default", "insensitive"]>;
};
// Schema types using V namespace (prevents TS7056)
export type StringFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      StringFilterBase<S> & {
        not: V.Union<
          readonly [V.ShorthandFilter<S>, V.Object<StringFilterBase<S>>]
        >;
      }
    >,
  ]
>;

const buildStringFilterSchema = <S extends V.Schema>(
  schema: S
): StringFilterSchema<S> => {
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

export type StringListFilterBaseSchema<S extends V.Schema> = {
  equals: S;
  has: V.String;
  hasEvery: V.String<{ array: true }>;
  hasSome: V.String<{ array: true }>;
  isEmpty: V.Boolean;
};

export type StringListFilterSchema<S extends V.Schema> = V.Union<
  readonly [
    V.ShorthandFilter<S>,
    V.Object<
      StringListFilterBaseSchema<S> & {
        not: V.Union<
          readonly [
            V.ShorthandFilter<S>,
            V.Object<StringListFilterBaseSchema<S>>,
          ]
        >;
      }
    >,
  ]
>;

const stringListFilterBase = v.object({
  has: stringBase,
  hasEvery: stringList,
  hasSome: stringList,
  isEmpty: v.boolean(),
});

const buildStringListFilterSchema = <S extends V.Schema>(
  schema: S
): StringListFilterSchema<S> => {
  const filter = stringListFilterBase.extend({
    equals: schema,
  });
  return v.union([
    shorthandFilter(schema),
    filter.extend({ not: v.union([shorthandFilter(schema), filter]) }),
  ]);
};

export type StringUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

const buildStringUpdateSchema = <S extends V.Schema>(
  schema: S
): StringUpdateSchema<S> =>
  v.union([
    shorthandUpdate(schema),
    v.object({ set: schema }, { partial: false }),
  ]);

export type StringListUpdateSchema<S extends V.Schema> = V.Union<
  [
    V.ShorthandUpdate<S>,
    V.Object<{
      set: S;
      push: V.Union<
        readonly [V.ShorthandArray<V.String>, V.String<{ array: true }>]
      >;
      unshift: V.Union<
        readonly [V.ShorthandArray<V.String>, V.String<{ array: true }>]
      >;
    }>,
  ]
>;

const buildStringListUpdateSchema = <S extends V.Schema>(
  schema: S
): StringListUpdateSchema<S> => {
  return v.union([
    shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([shorthandArray(stringBase), stringList]),
      unshift: v.union([shorthandArray(stringBase), stringList]),
    }),
  ]);
};

export interface StringSchemas<F extends FieldState<"string">> {
  base: F["base"];
  create: V.String<F>;
  update: F["array"] extends true
    ? StringListUpdateSchema<F["base"]>
    : StringUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? StringListFilterSchema<F["base"]>
    : StringFilterSchema<F["base"]>;
}

export const buildStringSchema = <F extends FieldState<"string">>(
  state: F
): StringSchemas<F> => {
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

export type InferStringInput<
  F extends FieldState<"string">,
  Type extends keyof StringSchemas<F>,
> = InferInput<StringSchemas<F>[Type]>;

export type InferStringOutput<
  F extends FieldState<"string">,
  Type extends keyof StringSchemas<F>,
> = InferOutput<StringSchemas<F>[Type]>;
