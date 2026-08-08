import {
  type AnyPolymorphicRelation,
  type AnyRelation,
  isPolymorphicRelation,
} from "@schema/relation";
import type { Scalar } from "@schema/scalars/base";

/**
 * Record of model fields - the canonical type for scalar and relation definitions.
 * Supports both Scalar instances and relation instances.
 */
export type AnyModelField = Scalar | AnyRelation | AnyPolymorphicRelation;
export type ModelShape = Record<string, AnyModelField>;

export type NameFromKeys<
  TFields extends string[],
  TName extends string = "",
> = TFields extends readonly [
  infer F extends string,
  ...infer R extends string[],
]
  ? R extends []
    ? `${TName}_${F}`
    : NameFromKeys<R, TName extends "" ? F : `${TName}_${F}`>
  : never;

export interface CompoundConstraint<
  TFields extends string[],
  TName extends string | undefined = undefined,
> {
  fields: TFields;
  name: TName extends undefined ? NameFromKeys<TFields> : TName;
}

/** Any compound constraint (for loose typing) */
export type AnyCompoundConstraint = CompoundConstraint<string[]>;

export type ToString<T> = T extends
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  ? `${T}`
  : never;

export type StringKeyOf<T extends Record<string, any>> = {
  [K in keyof T]: K extends string ? K : never;
}[keyof T];

export type ScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar ? ToString<K> : never;
}[keyof T];

/** Extract relation keys from ModelState */
export type RelationKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends AnyRelation ? ToString<K> : never;
}[keyof T];

export type PolymorphicRelationKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends AnyPolymorphicRelation ? ToString<K> : never;
}[keyof T];

export type RequiredScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["optional"] extends true
      ? never
      : ToString<K>
    : never;
}[keyof T];

export type UniqueScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["isId"] extends true
      ? ToString<K>
      : T[K]["~"]["state"]["isUnique"] extends true
        ? ToString<K>
        : never
    : never;
}[keyof T];

/** Numeric scalar types for aggregations (avg, sum) */
export type NumericScalarType = "int" | "float" | "decimal" | "bigint";

/** Extract keys of numeric scalars from a ModelShape */
export type NumericScalarKeys<T extends ModelShape> = {
  [K in keyof T]: T[K] extends Scalar
    ? T[K]["~"]["state"]["type"] extends NumericScalarType
      ? ToString<K>
      : never
    : never;
}[keyof T];

export type ScalarMap<T extends ModelShape> = {
  [K in ScalarKeys<T>]: T[K] extends Scalar ? T[K] : never;
};

export type RelationMap<T extends ModelShape> = {
  [K in RelationKeys<T>]: T[K] extends AnyRelation ? T[K] : never;
};

export type PolymorphicRelationMap<T extends ModelShape> = {
  [K in PolymorphicRelationKeys<T>]: T[K] extends AnyPolymorphicRelation
    ? T[K]
    : never;
};

export type UniqueScalarMap<T extends ModelShape> = {
  [K in UniqueScalarKeys<T>]: T[K] extends Scalar ? T[K] : never;
};

/** Check if a value is a relation (has ["~"].state.type matching relation types) */
function isRelation(value: unknown): value is AnyRelation {
  if (!value || typeof value !== "object") return false;
  const v = value as any;
  if (!v["~"]?.state?.type) return false;
  const type = v["~"].state.type;
  return (
    type === "oneToOne" ||
    type === "oneToMany" ||
    type === "manyToOne" ||
    type === "manyToMany"
  );
}

const SCALAR_TYPES = new Set<string>([
  "string",
  "int",
  "float",
  "decimal",
  "boolean",
  "datetime",
  "date",
  "time",
  "bigint",
  "json",
  "blob",
  "vector",
  "point",
  "enum",
]);

function isScalar(value: unknown): value is Scalar {
  if ((typeof value !== "object" || value === null) && typeof value !== "function") {
    return false;
  }
  const internal = Reflect.get(value, "~");
  if (typeof internal !== "object" || internal === null) return false;
  const state = Reflect.get(internal, "state");
  if (typeof state !== "object" || state === null) return false;
  const type = Reflect.get(state, "type");
  return typeof type === "string" && SCALAR_TYPES.has(type);
}

export const extractScalarMap = <T extends ModelShape>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (isScalar(value)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as ScalarMap<T>
  );
};

export const extractPolymorphicRelationMap = <T extends ModelShape>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (isPolymorphicRelation(value)) acc[key] = value;
      return acc;
    },
    {} as PolymorphicRelationMap<T>
  );
};

export const extractRelationMap = <T extends ModelShape>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (isRelation(value)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as RelationMap<T>
  );
};

export const extractUniqueScalarMap = <T extends ModelShape>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (
        isScalar(value) &&
        (value["~"].state.isUnique || value["~"].state.isId)
      ) {
        acc[key] = value;
      }
      return acc;
    },
    {} as UniqueScalarMap<T>
  );
};

export const getNameFromKeys = <
  Name extends string | undefined,
  TFields extends any[],
>(
  name: Name,
  fields: TFields
) => {
  return (
    name ??
    (fields.join("_") as Name extends undefined ? NameFromKeys<TFields> : Name)
  );
};
