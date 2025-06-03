import type { Model } from "../../../schema/model.js";
import type { Relation } from "../../../schema/relation.js";
import type { WhereInput, WhereUniqueInput } from "../query/where-input.js";
import type { SelectInput, IncludeInput } from "../query/select-input.js";
import type { ValidateSelectInclude } from "../query/select-input.js";
import type {
  FieldNames,
  RelationNames,
  ModelRelations,
  MapModelCreateFields,
  ModelFields,
} from "../foundation/index.js";
import { FieldUpdateOperations } from "../query/update-input.js";
import { BaseField } from "../../../schema/field.js";

// ===== CREATE OPERATIONS =====

/**
 * Arguments for create operations
 */
export type CreateArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  data: CreateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for createMany operations
 */
export type CreateManyArgs<TModel extends Model<any>> = {
  data: CreateInput<TModel, false>[] | CreateInput<TModel, false>;
  skipDuplicates?: boolean;
};

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

// ===== UPDATE OPERATIONS =====

/**
 * Arguments for update operations
 */
export type UpdateArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  data: UpdateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for updateMany operations
 */
export type UpdateManyArgs<TModel extends Model<any>> = {
  where: WhereInput<TModel>;
  data: UpdateInput<TModel, false>;
};

// Enhanced update type with field-specific operations
export type ScalarUpdateInput<TModel extends Model<any>> =
  FieldNames<TModel> extends never
    ? {}
    : {
        [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
          ? ModelFields<TModel>[K] extends BaseField<any>
            ? FieldUpdateOperations<ModelFields<TModel>[K]>
            : never
          : never;
      };

/**
 * Input for updating a record
 */
export type UpdateInput<
  TModel extends Model<any>,
  Deep extends boolean = true
> = ScalarUpdateInput<TModel> &
  (Deep extends true
    ? {
        // Relation update operations
        [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
          ? ModelRelations<TModel>[K] extends Relation<any, any>
            ? RelationUpdateInput<ModelRelations<TModel>[K]>
            : never
          : never;
      }
    : {});

// ===== UPSERT OPERATIONS =====

/**
 * Arguments for upsert operations
 */
export type UpsertArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  create: CreateInput<TModel>;
  update: UpdateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

// ===== DELETE OPERATIONS =====

/**
 * Arguments for delete operations
 */
export type DeleteArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for deleteMany operations
 */
export type DeleteManyArgs<TModel extends Model<any>> = {
  where: WhereInput<TModel>;
};

// ===== RELATION MUTATION INPUTS =====

/**
 * Extract the target model from a relation for mutation operations
 */
export type ExtractRelationModelForMutation<TRelation> =
  TRelation extends Relation<infer TGetter, any>
    ? TGetter extends () => infer TModel
      ? TModel extends Model<any>
        ? TModel
        : never
      : never
    : never;

/**
 * Relation create input - differentiates between single and multiple relations
 */
export type RelationCreateInput<TRelation extends Relation<any, any>> =
  TRelation extends Relation<any, infer TRelationType>
    ? TRelationType extends "oneToOne" | "manyToOne"
      ? SingleRelationCreateInput<ExtractRelationModelForMutation<TRelation>>
      : TRelationType extends "oneToMany" | "manyToMany"
      ? MultiRelationCreateInput<ExtractRelationModelForMutation<TRelation>>
      : never
    : never;

/**
 * Relation update input - differentiates between single and multiple relations
 */
export type RelationUpdateInput<TRelation extends Relation<any, any>> =
  TRelation extends Relation<any, infer TRelationType>
    ? TRelationType extends "oneToOne" | "manyToOne"
      ? SingleRelationUpdateInput<ExtractRelationModelForMutation<TRelation>>
      : TRelationType extends "oneToMany" | "manyToMany"
      ? MultiRelationUpdateInput<ExtractRelationModelForMutation<TRelation>>
      : never
    : never;

// ===== SINGLE RELATION OPERATIONS =====

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

/**
 * Update operations for single relations (oneToOne, manyToOne)
 */
export type SingleRelationUpdateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel>;
  connect?: WhereUniqueInput<TRelatedModel>;
  disconnect?: boolean;
  delete?: boolean;
  update?: UpdateInput<TRelatedModel>;
  upsert?: {
    create: CreateInput<TRelatedModel>;
    update: UpdateInput<TRelatedModel>;
  };
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

/**
 * Update operations for multi relations (oneToMany, manyToMany)
 */
export type MultiRelationUpdateInput<TRelatedModel extends Model<any>> = {
  create?: CreateInput<TRelatedModel> | CreateInput<TRelatedModel>[];
  connect?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
  disconnect?:
    | WhereUniqueInput<TRelatedModel>
    | WhereUniqueInput<TRelatedModel>[];
  delete?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
  update?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel>;
      }>;
  updateMany?:
    | {
        where: WhereInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel, false>;
      }
    | Array<{
        where: WhereInput<TRelatedModel>;
        data: UpdateInput<TRelatedModel, false>;
      }>;
  deleteMany?: WhereInput<TRelatedModel> | WhereInput<TRelatedModel>[];
  upsert?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
        update: UpdateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
        update: UpdateInput<TRelatedModel>;
      }>;
  connectOrCreate?:
    | {
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }
    | Array<{
        where: WhereUniqueInput<TRelatedModel>;
        create: CreateInput<TRelatedModel>;
      }>;
  set?: WhereUniqueInput<TRelatedModel> | WhereUniqueInput<TRelatedModel>[];
};

// ===== NESTED MUTATION INPUTS =====

/**
 * Nested create input for relations
 */
export type NestedCreateInput<TRelation extends Relation<any, any>> = {
  create?: CreateInput<ExtractRelationModelForMutation<TRelation>>;
  connect?: WhereUniqueInput<ExtractRelationModelForMutation<TRelation>>;
  connectOrCreate?: {
    where: WhereUniqueInput<ExtractRelationModelForMutation<TRelation>>;
    create: CreateInput<ExtractRelationModelForMutation<TRelation>>;
  };
};

/**
 * Nested update input for relations
 */
export type NestedUpdateInput<TRelation extends Relation<any, any>> = {
  create?: CreateInput<ExtractRelationModelForMutation<TRelation>>;
  connect?: WhereUniqueInput<ExtractRelationModelForMutation<TRelation>>;
  disconnect?: boolean;
  delete?: boolean;
  update?: UpdateInput<ExtractRelationModelForMutation<TRelation>>;
  upsert?: {
    create: CreateInput<ExtractRelationModelForMutation<TRelation>>;
    update: UpdateInput<ExtractRelationModelForMutation<TRelation>>;
  };
  connectOrCreate?: {
    where: WhereUniqueInput<ExtractRelationModelForMutation<TRelation>>;
    create: CreateInput<ExtractRelationModelForMutation<TRelation>>;
  };
};

// ===== BATCH OPERATIONS =====

/**
 * Batch payload result
 */
export type BatchPayload = {
  count: number;
};

/**
 * Arguments for batch operations
 */
export type BatchArgs<TData> = {
  data: TData[];
  skipDuplicates?: boolean;
};

// ===== FIELD UPDATE OPERATIONS =====

/**
 * Field-specific update operations that extend the base filters
 */
export type FieldUpdateInput<T> = T extends number
  ? NumberFieldUpdateInput
  : T extends string
  ? StringFieldUpdateInput
  : T extends boolean
  ? BooleanFieldUpdateInput
  : T extends Date
  ? DateTimeFieldUpdateInput
  : T extends any[]
  ? ArrayFieldUpdateInput<T>
  : T;

/**
 * Number field update operations
 */
export type NumberFieldUpdateInput =
  | {
      set?: number;
      increment?: number;
      decrement?: number;
      multiply?: number;
      divide?: number;
    }
  | number;

/**
 * String field update operations
 */
export type StringFieldUpdateInput =
  | {
      set?: string;
    }
  | string;

/**
 * Boolean field update operations
 */
export type BooleanFieldUpdateInput =
  | {
      set?: boolean;
    }
  | boolean;

/**
 * DateTime field update operations
 */
export type DateTimeFieldUpdateInput =
  | {
      set?: Date;
    }
  | Date;

/**
 * Array field update operations
 */
export type ArrayFieldUpdateInput<T extends any[]> =
  | {
      set?: T;
      push?: T[number] | T[number][];
    }
  | T;

// ===== TRANSACTION OPERATIONS =====

/**
 * Transaction arguments
 */
export type TransactionArgs<TOperations extends readonly any[]> = {
  operations: TOperations;
  isolationLevel?:
    | "ReadUncommitted"
    | "ReadCommitted"
    | "RepeatableRead"
    | "Serializable";
  timeout?: number;
};

/**
 * Individual transaction operation
 */
export type TransactionOperation<TModel extends Model<any>> =
  | { type: "create"; model: TModel; args: CreateArgs<TModel> }
  | { type: "update"; model: TModel; args: UpdateArgs<TModel> }
  | { type: "delete"; model: TModel; args: DeleteArgs<TModel> }
  | { type: "upsert"; model: TModel; args: UpsertArgs<TModel> };

// ===== UTILITY TYPES =====

/**
 * Extract mutation argument keys
 */
export type MutationArgKeys =
  | "data"
  | "where"
  | "create"
  | "update"
  | "select"
  | "include"
  | "skipDuplicates";

/**
 * Validate mutation arguments structure
 */
export type ValidateMutationArgs<TArgs> = TArgs extends Record<string, any>
  ? {
      [K in keyof TArgs]: K extends MutationArgKeys ? TArgs[K] : never;
    }
  : never;

/**
 * Check if input contains nested operations
 */
export type HasNestedOperations<TInput> = TInput extends Record<string, any>
  ? {
      [K in keyof TInput]: TInput[K] extends {
        create?: any;
        connect?: any;
        update?: any;
      }
        ? true
        : false;
    }[keyof TInput] extends true
    ? true
    : false
  : false;

/**
 * Extract nested operation types
 */
export type ExtractNestedOperations<TInput> = TInput extends Record<string, any>
  ? {
      [K in keyof TInput]: TInput[K] extends { create?: infer TCreate }
        ? TCreate
        : TInput[K] extends { connect?: infer TConnect }
        ? TConnect
        : TInput[K] extends { update?: infer TUpdate }
        ? TUpdate
        : never;
    }
  : never;
