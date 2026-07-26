import type { ScalarState } from "@schema/scalars/common";
import v, { type V } from "../primitives/v";
import { createScalarInterner, scalarInternKey } from "./intern";
import {
  buildNegatableFilterSchema,
  type NegatableFilterSchema,
} from "./negatable-filter";

// Base schemas
const stringBase = v.string();
const stringList = v.string({ array: true });

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

type StringFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  StringFilterBase<S>
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
  return buildNegatableFilterSchema<S, StringFilterBase<S>>(filter, schema);
};

type StringListFilterBaseSchema<S extends V.Schema> = {
  equals: S;
  has: V.String;
  hasEvery: V.String<{ array: true }>;
  hasSome: V.String<{ array: true }>;
  isEmpty: V.Boolean;
};

type StringListFilterSchema<S extends V.Schema> = NegatableFilterSchema<
  S,
  StringListFilterBaseSchema<S>
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
  return buildNegatableFilterSchema<S, StringListFilterBaseSchema<S>>(
    filter,
    schema
  );
};

type StringUpdateSchema<S extends V.Schema> = V.Union<
  readonly [V.ShorthandUpdate<S>, V.Object<{ set: S }, { partial: false }>]
>;

const buildStringUpdateSchema = <S extends V.Schema>(
  schema: S
): StringUpdateSchema<S> =>
  v.union([
    v.shorthandUpdate(schema),
    v.object({ set: schema }, { partial: false }),
  ]);

type StringListUpdateSchema<S extends V.Schema> = V.Union<
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
    v.shorthandUpdate(schema),
    v.object({
      set: schema,
      push: v.union([v.shorthandArray(stringBase), stringList]),
      unshift: v.union([v.shorthandArray(stringBase), stringList]),
    }),
  ]);
};

export interface StringSchemas<F extends ScalarState<"string">> {
  base: F["base"];
  create: V.String<F>;
  update: F["array"] extends true
    ? StringListUpdateSchema<F["base"]>
    : StringUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? StringListFilterSchema<F["base"]>
    : StringFilterSchema<F["base"]>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildStringSchema = <F extends ScalarState<"string">>(
  state: F
): StringSchemas<F> => {
  const key = scalarInternKey(state);
  return {
    base: state.base as F["base"],
    create: v.string(state),
    update: internUpdate(key, () =>
      state.array
        ? buildStringListUpdateSchema(state.base)
        : buildStringUpdateSchema(state.base)
    ) as never,
    filter: internFilter(key, () =>
      state.array
        ? buildStringListFilterSchema(state.base)
        : buildStringFilterSchema(state.base)
    ) as never,
  } as StringSchemas<F>;
};
