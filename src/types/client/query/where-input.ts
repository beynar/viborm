// Where Input Types
import type { Model } from "../../../schema/model.js";
import type { Relation } from "../../../schema/relation.js";
import type { BaseField } from "../../../schema/fields/base.js";
import type {
  FieldNames,
  RelationNames,
  ModelFields,
  ModelRelations,
  MapFieldType,
} from "../foundation/index.js";
import type { FieldFilter } from "./filters.js";

/**
 * Extract target model from relation
 */
export type ExtractRelationModel<TRelation> = TRelation extends Relation<
  infer TGetter,
  any
>
  ? TGetter extends () => infer TModel
    ? TModel extends Model<any>
      ? TModel
      : never
    : never
  : never;

/**
 * Relation filters for different relation types
 */
export type OneToOneRelationFilter<TRelatedModel extends Model<any>> =
  WhereInput<TRelatedModel> | null;

export type ManyToOneRelationFilter<TRelatedModel extends Model<any>> =
  WhereInput<TRelatedModel> | null;

export type OneToManyRelationFilter<TRelatedModel extends Model<any>> = {
  some?: WhereInput<TRelatedModel>;
  every?: WhereInput<TRelatedModel>;
  none?: WhereInput<TRelatedModel>;
};

export type ManyToManyRelationFilter<TRelatedModel extends Model<any>> = {
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
      ? FieldFilter<MapFieldType<ModelFields<TModel>[K]>>
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
        ? OneToOneRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : TRelationType extends "manyToOne"
        ? ManyToOneRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : TRelationType extends "oneToMany"
        ? OneToManyRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : TRelationType extends "manyToMany"
        ? ManyToManyRelationFilter<
            ExtractRelationModel<ModelRelations<TModel>[K]>
          >
        : never
      : never
    : never;
} & {
  AND?: WhereInput<TModel> | WhereInput<TModel>[];
  OR?: WhereInput<TModel>[];
  NOT?: WhereInput<TModel> | WhereInput<TModel>[];
};

/**
 * Unique where input
 */
export type WhereUniqueInput<TModel extends Model<any>> = {
  id?: string;
};
