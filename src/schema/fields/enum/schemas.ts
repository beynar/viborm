// Enum Field Schemas
// Factory pattern for enum field variants following the established schema structure

import {
  array,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  InferInput,
  NullableSchema,
  ArraySchema,
} from "valibot";
import {
  AnySchema,
  extend,
  FieldState,
  SchemaWithDefault,
  shorthandFilter,
  shorthandUpdate,
  createWithDefault,
} from "../common";

// =============================================================================
// FILTER FACTORIES
// =============================================================================

const enumFilterFactory = <S extends AnySchema>(base: S) => {
  const filterBase = partial(
    object({
      equals: base,
      in: array(base),
      notIn: array(base),
    })
  );
  return union([
    shorthandFilter(base),
    extend(filterBase, {
      not: optional(union([shorthandFilter(base), filterBase])),
    }),
  ]);
};

const enumNullableFilterFactory = <S extends AnySchema>(base: S) => {
  const nullableBase = nullable(base);
  const filterBase = partial(
    object({
      equals: nullableBase,
      in: array(base),
      notIn: array(base),
    })
  );
  return union([
    shorthandFilter(nullableBase),
    extend(filterBase, {
      not: optional(union([shorthandFilter(nullableBase), filterBase])),
    }),
  ]);
};

const enumListFilterFactory = <S extends AnySchema>(base: S) => {
  const list = array(base);
  const listFilterBase = partial(
    object({
      equals: list,
      has: base,
      hasEvery: array(base),
      hasSome: array(base),
      isEmpty: boolean(),
    })
  );
  return union([
    shorthandFilter(list),
    extend(listFilterBase, {
      not: optional(union([shorthandFilter(list), listFilterBase])),
    }),
  ]);
};

const enumListNullableFilterFactory = <S extends AnySchema>(base: S) => {
  const listNullable = nullable(array(base));
  const listFilterBase = partial(
    object({
      equals: listNullable,
      has: base,
      hasEvery: array(base),
      hasSome: array(base),
      isEmpty: boolean(),
    })
  );
  return union([
    shorthandFilter(listNullable),
    extend(listFilterBase, {
      not: optional(union([shorthandFilter(listNullable), listFilterBase])),
    }),
  ]);
};

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const enumUpdateFactory = <S extends AnySchema>(base: S) =>
  union([shorthandUpdate(base), partial(object({ set: base }))]);

const enumNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(base)),
    partial(object({ set: nullable(base) })),
  ]);

const enumListUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(array(base)),
    partial(
      object({
        set: array(base),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

const enumListNullableUpdateFactory = <S extends AnySchema>(base: S) =>
  union([
    shorthandUpdate(nullable(array(base))),
    partial(
      object({
        set: nullable(array(base)),
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
  ]);

// =============================================================================
// SCHEMA BUILDERS
// =============================================================================

export const enumSchemas = <const F extends FieldState<"enum">>(f: F) => {
  return {
    base: f.base,
    filter: enumFilterFactory(f.base),
    create: createWithDefault(f, f.base),
    update: enumUpdateFactory(f.base),
  } as unknown as EnumSchemas<F>;
};

type EnumSchemas<F extends FieldState<"enum">> = {
  base: F["base"];
  filter: ReturnType<typeof enumFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof enumUpdateFactory<F["base"]>>;
};

export const enumNullableSchemas = <F extends FieldState<"enum">>(f: F) => {
  return {
    base: nullable(f.base),
    filter: enumNullableFilterFactory(f.base),
    create: createWithDefault(f, nullable(f.base)),
    update: enumNullableUpdateFactory(f.base),
  } as unknown as EnumNullableSchemas<F>;
};

type EnumNullableSchemas<F extends FieldState<"enum">> = {
  base: NullableSchema<F["base"], undefined>;
  filter: ReturnType<typeof enumNullableFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof enumNullableUpdateFactory<F["base"]>>;
};

export const enumListSchemas = <F extends FieldState<"enum">>(f: F) => {
  return {
    base: array(f.base),
    filter: enumListFilterFactory(f.base),
    create: createWithDefault(f, array(f.base)),
    update: enumListUpdateFactory(f.base),
  } as unknown as EnumListSchemas<F>;
};

type EnumListSchemas<F extends FieldState<"enum">> = {
  base: ArraySchema<F["base"], undefined>;
  filter: ReturnType<typeof enumListFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof enumListUpdateFactory<F["base"]>>;
};

export const enumListNullableSchemas = <F extends FieldState<"enum">>(f: F) => {
  return {
    base: nullable(array(f.base)),
    filter: enumListNullableFilterFactory(f.base),
    create: createWithDefault(f, nullable(array(f.base))),
    update: enumListNullableUpdateFactory(f.base),
  } as unknown as EnumListNullableSchemas<F>;
};

type EnumListNullableSchemas<F extends FieldState<"enum">> = {
  base: NullableSchema<ArraySchema<F["base"], undefined>, undefined>;
  filter: ReturnType<typeof enumListNullableFilterFactory<F["base"]>>;
  create: SchemaWithDefault<F>;
  update: ReturnType<typeof enumListNullableUpdateFactory<F["base"]>>;
};

// =============================================================================
// TYPE INFERENCE
// =============================================================================

export type InferEnumSchemas<F extends FieldState<"enum">> =
  F["array"] extends true
    ? F["nullable"] extends true
      ? EnumListNullableSchemas<F>
      : EnumListSchemas<F>
    : F["nullable"] extends true
    ? EnumNullableSchemas<F>
    : EnumSchemas<F>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldEnumSchemas = <F extends FieldState<"enum">>(f: F) => {
  return (
    f.array
      ? f.nullable
        ? enumListNullableSchemas(f)
        : enumListSchemas(f)
      : f.nullable
      ? enumNullableSchemas(f)
      : enumSchemas(f)
  ) as InferEnumSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferEnumInput<
  F extends FieldState<"enum">,
  Type extends "create" | "update" | "filter" | "base"
> = InferInput<InferEnumSchemas<F>[Type]>;
