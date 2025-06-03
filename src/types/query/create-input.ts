import {
  ExtractRelationModel,
  ModelRelations,
  MapModelCreateFields,
  RelationNames,
} from "../foundation";
import { Model, Relation } from "@schema";
import { WhereUniqueInput } from "./where-input";

/**
 * Input for creating a new record
 */
export type CreateInput<
  TModel extends Model<any>,
  Deep extends boolean = true
> = MapModelCreateFields<TModel> &
  (Deep extends true
    ? {
        // Relation create operations
        [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
          ? ModelRelations<TModel>[K] extends Relation<any, any>
            ? RelationCreateInput<ModelRelations<TModel>[K]>
            : never
          : never;
      }
    : {});

/**
 * Relation create input - differentiates between single and multiple relations
 */
export type RelationCreateInput<TRelation extends Relation<any, any>> =
  TRelation extends Relation<any, infer TRelationType>
    ? TRelationType extends "oneToOne" | "manyToOne"
      ? SingleRelationCreateInput<ExtractRelationModel<TRelation>>
      : TRelationType extends "oneToMany" | "manyToMany"
      ? MultiRelationCreateInput<ExtractRelationModel<TRelation>>
      : never
    : never;

/**
 * Create operations for single relations (oneToOne, manyToOne)
 */
export type SingleRelationCreateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel>;
  connect?: WhereUniqueInput<TRelatedModel>;
  connectOrCreate?: {
    where: WhereUniqueInput<TRelatedModel>;
    create: CreateInput<TRelatedModel>;
  };
};

// ===== MULTI RELATION OPERATIONS =====

/**
 * Create operations for multi relations (oneToMany, manyToMany)
 */
export type MultiRelationCreateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel> | CreateInput<TRelatedModel>[];
  connect?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
  connectOrCreate?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }>;
};

// ===== NESTED MUTATION INPUTS =====

/**
 * Nested create input for relations
 */
export type NestedCreateInput<TRelation extends Relation<any, any>> = {
  create?: CreateInput<ExtractRelationModel<TRelation>>;
  connect?: WhereUniqueInput<ExtractRelationModel<TRelation>>;
  connectOrCreate?: {
    where: WhereUniqueInput<ExtractRelationModel<TRelation>>;
    create: CreateInput<ExtractRelationModel<TRelation>>;
  };
};
