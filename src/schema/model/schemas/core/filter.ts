// Filter schema factories

import {
  object,
  optional,
  type ObjectSchema,
  type InferInput,
  type OptionalSchema,
} from "valibot";
import { model, type ModelState } from "../../model";
import type { SchemaEntries } from "../types";
import { oneToOne } from "../../../relation/relation";
import {
  forEachScalarField,
  forEachRelation,
  forEachUniqueField,
} from "../utils";
import { string } from "@schema/fields";
import {
  ScalarFields,
  RelationFields,
  UniqueFields,
  RelationKeys,
} from "@schema/model";
import { ScalarFieldKeys } from "@schema/model/types/helpers";

// =============================================================================
// KEY EXTRACTORS (reusable across schema files)
// =============================================================================

// =============================================================================
// SCALAR FILTER
// =============================================================================

/** Scalar filter schema - each scalar field's filter, all optional */
export type ScalarFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["scalars"]]: OptionalSchema<
      T["scalars"][K]["~"]["schemas"]["filter"],
      undefined
    >;
  },
  undefined
>;

/** Input type for scalar filter */
export type ScalarFilterInput<T extends ModelState> = InferInput<
  ScalarFilterSchema<T>
>;

export const getScalarFilter = <T extends ModelState>(state: T) => {
  const entries: SchemaEntries = {};
  forEachScalarField(state, (name, field) => {
    entries[name] = optional(field["~"].schemas.filter);
  });
  return object(entries) as ScalarFilterSchema<T>;
};

// =============================================================================
// UNIQUE FILTER
// =============================================================================

/** Unique filter schema - only id/unique fields with base schema */
export type UniqueFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["uniques"]]: OptionalSchema<
      T["uniques"][K]["~"]["schemas"]["base"],
      undefined
    >;
  },
  undefined
>;

/** Input type for unique filter */
export type UniqueFilterInput<T extends ModelState> = InferInput<
  UniqueFilterSchema<T>
>;

export const getUniqueFilter = <T extends ModelState>(state: T) => {
  const entries: SchemaEntries = {};
  forEachUniqueField(state, (name, unique) => {
    entries[name] = optional(unique["~"].schemas.base);
  });
  return object(entries) as UniqueFilterSchema<T>;
};

// =============================================================================
// RELATION FILTER
// =============================================================================

/** Relation filter schema - each relation's filter, all optional */
export type RelationFilterSchema<T extends ModelState> = ObjectSchema<
  {
    [K in keyof T["relations"]]: OptionalSchema<
      T["relations"][K]["~"]["schemas"]["filter"],
      undefined
    >;
  },
  undefined
>;

/** Input type for relation filter */
export type RelationFilterInput<T extends ModelState> = InferInput<
  RelationFilterSchema<T>
>;

export const getRelationFilter = <T extends ModelState>(
  state: T
): RelationFilterSchema<T> => {
  const entries: SchemaEntries = {};
  forEachRelation(state, (name, relation) => {
    entries[name] = optional(relation["~"].schemas.filter);
  });
  return object(entries) as RelationFilterSchema<T>;
};

const otherModel = model({
  id: string().id(),
  name: string(),
});
const modelTest = model({
  id: string().id(),
  name: string(),
  other: oneToOne(() => otherModel, { optional: true }),
});
type Fields = (typeof modelTest)["~"]["state"]["fields"];
type Scalars = ScalarFieldKeys<Fields>;
type ScalarRecord = ScalarFields<Fields>;
type UniqueRecord = UniqueFields<Fields>;
type RelationRecord = RelationFields<Fields>;
type Relations = RelationKeys<Fields>;

type TestFilter = ScalarFilterSchema<(typeof modelTest)["~"]["state"]>;
type Test = ScalarFilterSchema<(typeof modelTest)["~"]["state"]>;
