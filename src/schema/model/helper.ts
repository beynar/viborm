import { Field } from "@schema/fields/base";
import { FieldRecord } from "@schema/model";
import { AnyRelation, Relation } from "@schema/relation/relation";

type ToString<T> = T extends
  | string
  | number
  | bigint
  | boolean
  | null
  | undefined
  ? `${T}`
  : never;

export type ScalarFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field ? ToString<K> : never;
}[keyof T];

/** Extract relation keys from ModelState */
export type RelationKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends AnyRelation ? ToString<K> : never;
}[keyof T];

export type UniqueFieldKeys<T extends FieldRecord> = {
  [K in keyof T]: T[K] extends Field
    ? T[K]["~"]["state"]["isId"] extends true
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

export const extractScalarFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce((acc, [key, value]) => {
    if (!(value instanceof Relation)) {
      acc[key] = value;
    }
    return acc;
  }, {} as ScalarFields<T>);
};

export const extractRelationFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce((acc, [key, value]) => {
    if (value instanceof Relation) {
      acc[key] = value;
    }
    return acc;
  }, {} as RelationFields<T>);
};

export const extractUniqueFields = <T extends FieldRecord>(fields: T) => {
  return Object.entries(fields).reduce((acc, [key, value]) => {
    if (
      (!(value instanceof Relation) && value["~"].state.isUnique) ||
      value["~"].state.isId
    ) {
      acc[key] = value;
    }
    return acc;
  }, {} as UniqueFields<T>);
};
