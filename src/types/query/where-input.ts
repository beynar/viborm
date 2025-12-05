// Where Input Types
import type { Model, BaseField, Relation } from "@schema";
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
    ? ModelFields<TModel>[K] extends BaseField<any>
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
 * Unique where input - allows filtering on unique attributes and id
 */
export type WhereUniqueInput<TModel extends Model<any>> = {
  [K in GetUniqueFields<TModel>]?: ModelFields<TModel>[K] extends BaseField<any>
    ? MapFieldType<ModelFields<TModel>[K]>
    : never;
};
