// Where Input Types
import type { Model, Field, Relation } from "@schema";
import type {
  ExtractCompoundId,
  ExtractCompoundUniques,
  AnyCompoundConstraint,
  EffectiveKeyName,
} from "@schema";
import type {
  FieldNames,
  RelationNames,
  ModelFields,
  ModelRelations,
  MapFieldType,
  GetUniqueFields,
  ExtractRelationModel,
} from "../foundation/index.js";
import type { FieldFilter } from "./filters-input.js";

/**
 * Relation filters for different relation types
 */

export type SingularRelationFilter<TRelatedModel extends Model<any>> =
  WhereInput<TRelatedModel> | null;

export type PluralRelationFilter<TRelatedModel extends Model<any>> = {
  some?: WhereInput<TRelatedModel>;
  every?: WhereInput<TRelatedModel>;
  none?: WhereInput<TRelatedModel>;
};

/**
 * Scalar where input - only field filters, no relations
 */
export type ScalarWhereInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends Field
      ? FieldFilter<ModelFields<TModel>[K]>
      : never
    : never;
};

/**
 * Main where input with relations
 */
export type WhereInput<TModel extends Model<any>> = ScalarWhereInput<TModel> & {
  [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, infer TRelationType>
      ? TRelationType extends "oneToOne"
        ? SingularRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : TRelationType extends "manyToOne"
        ? SingularRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : TRelationType extends "oneToMany"
        ? PluralRelationFilter<ExtractRelationModel<ModelRelations<TModel>[K]>>
        : TRelationType extends "manyToMany"
        ? PluralRelationFilter<ExtractRelationModel<ModelRelations<TModel>[K]>>
        : never
      : never
    : never;
} & {
  AND?: WhereInput<TModel> | WhereInput<TModel>[];
  OR?: WhereInput<TModel>[];
  NOT?: WhereInput<TModel> | WhereInput<TModel>[];
};

/**
 * Single-field unique input - allows filtering on unique attributes and id
 */
type SingleFieldUniqueInput<TModel extends Model<any>> = {
  [K in GetUniqueFields<TModel>]?: ModelFields<TModel>[K] extends Field
    ? MapFieldType<ModelFields<TModel>[K]>
    : never;
};

/**
 * Compound key object type - generates { field1: type1, field2: type2 } from field names
 */
type CompoundKeyObject<TModel extends Model<any>, Fields extends readonly string[]> = {
  [K in Fields[number] as K extends keyof ModelFields<TModel>
    ? K
    : never]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends Field
      ? MapFieldType<ModelFields<TModel>[K]>
      : never
    : never;
};

/**
 * Compound ID input - generates { keyName: { field1, field2 } } from model's compound ID
 */
type CompoundIdInput<TModel extends Model<any>> =
  ExtractCompoundId<TModel> extends AnyCompoundConstraint
    ? {
        [K in EffectiveKeyName<ExtractCompoundId<TModel>>]: CompoundKeyObject<
          TModel,
          ExtractCompoundId<TModel>["fields"]
        >;
      }
    : never;

/**
 * Extracts compound unique inputs recursively from the tuple type
 */
type ExtractCompoundUniquesInputs<
  TModel extends Model<any>,
  TCompoundUniques extends readonly AnyCompoundConstraint[]
> = TCompoundUniques extends readonly [
  infer First extends AnyCompoundConstraint,
  ...infer Rest extends readonly AnyCompoundConstraint[]
]
  ?
      | {
          [K in EffectiveKeyName<First>]: CompoundKeyObject<TModel, First["fields"]>;
        }
      | ExtractCompoundUniquesInputs<TModel, Rest>
  : never;

/**
 * Compound uniques input - generates { keyName: { field1, field2 } } for each compound unique
 */
type CompoundUniquesInput<TModel extends Model<any>> =
  ExtractCompoundUniques<TModel> extends readonly AnyCompoundConstraint[]
    ? ExtractCompoundUniquesInputs<TModel, ExtractCompoundUniques<TModel>>
    : never;

/**
 * Unique where input - allows filtering on unique attributes, id, and compound keys
 */
export type WhereUniqueInput<TModel extends Model<any>> =
  | SingleFieldUniqueInput<TModel>
  | CompoundIdInput<TModel>
  | CompoundUniquesInput<TModel>;
