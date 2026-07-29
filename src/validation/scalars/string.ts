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
  contains: v.fieldRefOr("string", stringBase),
  startsWith: v.fieldRefOr("string", stringBase),
  endsWith: v.fieldRefOr("string", stringBase),
  mode: v.enum(["default", "insensitive"]),
});

/**
 * Comparison operand: a literal, a field reference to another string column, an
 * SQL fragment, or a callback returning one of the latter two.
 */
type StringOperand<
  S extends V.Schema,
  C extends V.Operand<any>,
> = V.ComparisonOperand<"string", S, C>;

/**
 * The text-predicate operand: a literal or a field reference, and nothing else.
 *
 * `contains` / `startsWith` / `endsWith` compile a referenced column fine (the
 * builder uses exact substring predicates, never LIKE patterns), so the
 * reference stays. The fragment — and with it the callback that returns one —
 * is drawn at the comparison operators only, where the builder's operand
 * handling is uniform. Acceptance that outran the builder would be
 * accept-and-ignore with extra steps.
 */
type StringTextOperand = V.FieldRefOr<"string", V.String>;

type StringFilterBase<S extends V.Schema, C extends V.Operand<any>> = {
  equals: StringOperand<S, C>;
  lt: StringOperand<S, C>;
  lte: StringOperand<S, C>;
  gt: StringOperand<S, C>;
  gte: StringOperand<S, C>;
  in: V.String<{ array: true }>;
  notIn: V.String<{ array: true }>;
  contains: StringTextOperand;
  startsWith: StringTextOperand;
  endsWith: StringTextOperand;
  mode: V.Enum<["default", "insensitive"]>;
};

type StringFilterSchema<
  S extends V.Schema,
  C extends V.Operand<any>,
> = NegatableFilterSchema<StringOperand<S, C>, StringFilterBase<S, C>>;

const buildStringFilterSchema = <S extends V.Schema, C extends V.Operand<any>>(
  schema: S
): StringFilterSchema<S, C> => {
  const operand = v.comparisonOperand("string", schema);
  const filter = stringFilterBase.extend({
    equals: operand,
    lt: operand,
    lte: operand,
    gt: operand,
    gte: operand,
  });
  return buildNegatableFilterSchema<
    StringOperand<S, C>,
    StringFilterBase<S, C>
  >(filter, operand);
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

export interface StringSchemas<
  F extends ScalarState<"string">,
  C extends V.Operand<any> = V.Operand<any>,
> {
  base: F["base"];
  create: V.String<F>;
  update: F["array"] extends true
    ? StringListUpdateSchema<F["base"]>
    : StringUpdateSchema<F["base"]>;
  filter: F["array"] extends true
    ? StringListFilterSchema<F["base"]>
    : StringFilterSchema<F["base"], C>;
}

const internFilter = createScalarInterner<unknown>();
const internUpdate = createScalarInterner<unknown>();

export const buildStringSchema = <
  F extends ScalarState<"string">,
  C extends V.Operand<any> = V.Operand<any>,
>(
  state: F
): StringSchemas<F, C> => {
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
  } as StringSchemas<F, C>;
};
