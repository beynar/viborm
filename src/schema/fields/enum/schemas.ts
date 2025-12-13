// Enum Field Schemas
// Value-driven factories without chained helpers (zod v4-mini style)

import {
  enum as _enum,
  array,
  boolean,
  nullable,
  object,
  optional,
  partial,
  union,
  _default,
  extend,
  type input as Input,
} from "zod/v4-mini";
import {
  FieldState,
  isOptional,
  shorthandFilter,
  shorthandUpdate,
} from "../common";
import { enumField } from "./field";
// =============================================================================
// STATE EXTENSION
// =============================================================================

export interface EnumFieldState<T extends string[] = string[]>
  extends FieldState<"enum"> {
  enumValues: T;
}

// =============================================================================
// BASE BUILDERS
// =============================================================================

const enumBase = <T extends string[]>(values: T) => _enum(values);

const enumNullable = <T extends string[]>(values: T) =>
  nullable(enumBase(values));

const enumList = <T extends string[]>(values: T) => array(enumBase(values));

const enumListNullable = <T extends string[]>(values: T) =>
  nullable(enumList(values));

// =============================================================================
// FILTER FACTORIES
// =============================================================================

const enumFilterFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  const filterBase = partial(
    object({
      equals: base,
      in: array(base),
      notIn: array(base),
    })
  );
  return union([
    extend(filterBase, {
      not: optional(union([filterBase, shorthandFilter(base)])),
    }),
    shorthandFilter(base),
  ]);
};

const enumNullableFilterFactory = <T extends string[]>(values: T) => {
  const base = enumNullable(values);
  const filterBase = partial(
    object({
      equals: base,
      in: array(enumBase(values)),
      notIn: array(enumBase(values)),
    })
  );
  return union([
    extend(filterBase, {
      not: optional(union([filterBase, base])),
    }),
    shorthandFilter(base),
  ]);
};

const enumListFilterFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  const list = enumList(values);
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
    extend(listFilterBase, {
      not: optional(union([listFilterBase, shorthandFilter(list)])),
    }),
    shorthandFilter(list),
  ]);
};

const enumListNullableFilterFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  const listNullable = enumListNullable(values);
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
    extend(listFilterBase, {
      not: optional(union([listFilterBase, shorthandFilter(listNullable)])),
    }),
    shorthandFilter(listNullable),
  ]);
};

// =============================================================================
// CREATE FACTORIES
// =============================================================================

const enumCreate = <T extends string[]>(values: T) => enumBase(values);

const enumNullableCreate = <T extends string[]>(values: T) =>
  _default(optional(enumNullable(values)), null);

const enumOptionalCreate = <T extends string[]>(values: T) =>
  optional(enumBase(values));

const enumOptionalNullableCreate = <T extends string[]>(values: T) =>
  _default(optional(enumNullable(values)), null);

const enumListCreate = <T extends string[]>(values: T) => enumList(values);

const enumListNullableCreate = <T extends string[]>(values: T) =>
  _default(optional(enumListNullable(values)), null);

const enumOptionalListCreate = <T extends string[]>(values: T) =>
  optional(enumList(values));

const enumOptionalListNullableCreate = <T extends string[]>(values: T) =>
  _default(optional(enumListNullable(values)), null);

// =============================================================================
// UPDATE FACTORIES
// =============================================================================

const enumUpdateFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  return union([partial(object({ set: base })), shorthandUpdate(base)]);
};

const enumNullableUpdateFactory = <T extends string[]>(values: T) => {
  const base = enumNullable(values);
  return union([partial(object({ set: base })), shorthandUpdate(base)]);
};

const enumListUpdateFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  const list = enumList(values);
  return union([
    partial(
      object({
        set: list,
        push: union([base, array(base)]),
        unshift: union([base, array(base)]),
      })
    ),
    shorthandUpdate(list),
  ]);
};

const enumListNullableUpdateFactory = <T extends string[]>(values: T) => {
  const base = enumBase(values);
  const listNullable = enumListNullable(values);
  return union([
    partial(
      object({
        set: listNullable,
        push: union([base, enumList(values)]),
        unshift: union([base, enumList(values)]),
      })
    ),
    shorthandUpdate(listNullable),
  ]);
};

// =============================================================================
// SCHEMA FACTORIES
// =============================================================================

export const enumSchemas = <T extends string[], Optional extends boolean>(
  values: T,
  o: Optional
) => {
  return {
    base: enumBase(values),
    filter: enumFilterFactory(values),
    create: (o === true
      ? enumOptionalCreate(values)
      : enumCreate(values)) as Optional extends true
      ? ReturnType<typeof enumOptionalCreate<T>>
      : ReturnType<typeof enumCreate<T>>,
    update: enumUpdateFactory(values),
  };
};

export const enumNullableSchemas = <
  T extends string[],
  Optional extends boolean
>(
  values: T,
  o: Optional
) => {
  return {
    base: enumNullable(values),
    filter: enumNullableFilterFactory(values),
    create: (o === true
      ? enumOptionalNullableCreate(values)
      : enumNullableCreate(values)) as Optional extends true
      ? ReturnType<typeof enumOptionalNullableCreate<T>>
      : ReturnType<typeof enumNullableCreate<T>>,
    update: enumNullableUpdateFactory(values),
  };
};

export const enumListSchemas = <T extends string[], Optional extends boolean>(
  values: T,
  o: Optional
) => {
  return {
    base: enumList(values),
    filter: enumListFilterFactory(values),
    create: (o === true
      ? enumOptionalListCreate(values)
      : enumListCreate(values)) as Optional extends true
      ? ReturnType<typeof enumOptionalListCreate<T>>
      : ReturnType<typeof enumListCreate<T>>,
    update: enumListUpdateFactory(values),
  };
};

export const enumListNullableSchemas = <
  T extends string[],
  Optional extends boolean
>(
  values: T,
  o: Optional
) => {
  return {
    base: enumListNullable(values),
    filter: enumListNullableFilterFactory(values),
    create: (o === true
      ? enumOptionalListNullableCreate(values)
      : enumListNullableCreate(values)) as Optional extends true
      ? ReturnType<typeof enumOptionalListNullableCreate<T>>
      : ReturnType<typeof enumListNullableCreate<T>>,
    update: enumListNullableUpdateFactory(values),
  };
};

// =============================================================================
// TYPE HELPERS
// =============================================================================

export type EnumListNullableSchemas<
  T extends string[],
  Optional extends boolean = false
> = ReturnType<typeof enumListNullableSchemas<T, Optional>>;

export type EnumListSchemas<
  T extends string[],
  Optional extends boolean = false
> = ReturnType<typeof enumListSchemas<T, Optional>>;

export type EnumNullableSchemas<
  T extends string[],
  Optional extends boolean = false
> = ReturnType<typeof enumNullableSchemas<T, Optional>>;

export type EnumSchemas<
  T extends string[],
  Optional extends boolean = false
> = ReturnType<typeof enumSchemas<T, Optional>>;

export type InferEnumSchemas<F extends EnumFieldState> = F["array"] extends true
  ? F["nullable"] extends true
    ? EnumListNullableSchemas<F["enumValues"], isOptional<F>>
    : EnumListSchemas<F["enumValues"], isOptional<F>>
  : F["nullable"] extends true
  ? EnumNullableSchemas<F["enumValues"], isOptional<F>>
  : EnumSchemas<F["enumValues"], isOptional<F>>;

// =============================================================================
// MAIN SCHEMA GETTER
// =============================================================================

export const getFieldEnumSchemas = <F extends EnumFieldState>(f: F) => {
  const isOpt = f.hasDefault || f.nullable;
  const isArr = f.array;
  const values = f.enumValues;
  return (isArr
    ? isOpt
      ? enumListNullableSchemas(values, isOpt)
      : enumListSchemas(values, isOpt)
    : isOpt
    ? enumNullableSchemas(values, isOpt)
    : enumSchemas(values, isOpt)) as unknown as InferEnumSchemas<F>;
};

// =============================================================================
// INPUT TYPE INFERENCE
// =============================================================================

export type InferEnumInput<
  F extends EnumFieldState,
  Type extends "create" | "update" | "filter"
> = Input<InferEnumSchemas<F>[Type]>;
