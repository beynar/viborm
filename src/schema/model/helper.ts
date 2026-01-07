import type { Field } from "@schema/fields/base";
import type { AnyRelation } from "@schema/relation";

/**
 * Record of model fields - the canonical type for field definitions.
 * Supports both scalar Field types and relation types.
 */
export type FieldRecord = Record<string, Field | AnyRelation>;

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

export type ScalarFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field ? ToString<K> : never;
}[keyof T];

/** Extract relation keys from ModelState */
export type RelationKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends AnyRelation ? ToString<K> : never;
}[keyof T];

export type RequiredFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["optional"] extends true
      ? never
      : ToString<K>
    : never;
}[keyof T];

export type UniqueFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["isId"] extends true
      ? ToString<K>
      : T[K]["~"]["state"]["isUnique"] extends true
        ? ToString<K>
        : never
    : never;
}[keyof T];

export type ScalarFields<T extends FieldRecord> = {
  [K in ScalarFieldKeys<T>]: T[K] extends Field ? T[K] : never;
};

export type RelationFields<T extends FieldRecord> = {
  [K in RelationKeys<T>]: T[K] extends AnyRelation ? T[K] : never;
};

export type UniqueFields<T extends FieldRecord> = {
  [K in UniqueFieldKeys<T>]: T[K] extends Field ? T[K] : never;
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

export const extractScalarFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (!isRelation(value)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as ScalarFields<T>
  );
};

export const extractRelationFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (isRelation(value)) {
        acc[key] = value;
      }
      return acc;
    },
    {} as RelationFields<T>
  );
};

export const extractUniqueFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce(
    (acc, [key, value]) => {
      if (
        !isRelation(value) &&
        (value["~"].state.isUnique || value["~"].state.isId)
      ) {
        acc[key] = value;
      }
      return acc;
    },
    {} as UniqueFields<T>
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
