import { FieldState } from "../common";
import v, { BaseStringSchema, VibSchema } from "../../../validation";

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

// Base filter object without `not` (used for recursive `not` definition)

// Shared filters for any non list string field

export const shorthandUpdate = <Z extends VibSchema>(schema: Z) =>
  v.coerce(schema, (v: Z[" vibInferred"]["0"]) => ({ set: v }));

const shorthandFilter = <Z extends VibSchema>(schema: Z) =>
  v.coerce(schema, (v: Z[" vibInferred"]["0"]) => ({ equals: v }));

const stringFilterBase = v.object({
  in: stringList,
  notIn: stringList,
  contains: stringBase,
  startsWith: stringBase,
  endsWith: stringBase,
  mode: v.enum(["default", "insensitive"]),
});

const buildStringFilterSchema = <S extends VibSchema>(schema: S) => {
  return v.union([
    shorthandFilter(schema),
    stringFilterBase.extend({
      equal: schema,
      lt: schema,
      lte: schema,
      gt: schema,
      gte: schema,
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
  return v.union([
    shorthandFilter(schema),
    stringListFilterBase.extend({
      equals: schema,
    }),
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
      push: stringList,
      unshift: stringList,
    }),
  ]);

export const buildStringSchema = <F extends FieldState<"string">>(state: F) => {
  const create = v.string(state);
  const base = v.string<Pick<F, "array" | "nullable" | "schema">>({
    array: state.array,
    nullable: state.nullable,
    schema: state.schema,
  });

  return {
    create,
    update: state.array
      ? buildStringListUpdateSchema(base)
      : buildStringUpdateSchema(base),
    filter: state.array
      ? buildStringListFilterSchema(base)
      : buildStringFilterSchema(base),
  } as VibStringSchemas<F, typeof base>;
};
type VibStringSchemas<
  F extends FieldState<"string">,
  Base extends VibSchema
> = {
  create: BaseStringSchema<F>;
  update: F["array"] extends true
    ? ReturnType<typeof buildStringListUpdateSchema<Base>>
    : ReturnType<typeof buildStringUpdateSchema<Base>>;
  filter: F["array"] extends true
    ? ReturnType<typeof buildStringListFilterSchema<Base>>
    : ReturnType<typeof buildStringFilterSchema<Base>>;
};
