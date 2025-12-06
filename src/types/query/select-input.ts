// Selection Input Types
// Type-safe field selection interfaces for VibORM queries

import type { Model, Field, Relation } from "@schema";
import type {
  FieldNames,
  RelationNames,
  ModelFields,
  ModelRelations,
  MapFieldType,
} from "../foundation/index.js";

// Import types that will be used in nested inputs
import type { WhereInput } from "./where-input.js";
import type { OrderByInput } from "./orderby-input.js";
import { CountSelectInput } from "../operations/find-args.js";
import { SimplifyDeep } from "../utilities.js";

// ===== CORE SELECTION TYPES =====

/**
 * Base selection input for scalar fields only
 */
export type BaseSelectInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: boolean;
};

/**
 * Enhanced selection input that includes relation selection
 */
export type SelectInput<TModel extends Model<any>> = {
  // Scalar field selection
  [K in FieldNames<TModel>]?: boolean;
} & {
  // Relation field selection - can be boolean or nested select
  [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, any>
      ? boolean | NestedSelectInput<ModelRelations<TModel>[K]>
      : never
    : never;
} & {
  _count?: {
    select: CountSelectInput<TModel>;
  };
};

/**
 * Include input - alternative to select for relation inclusion
 */
export type IncludeInput<TModel extends Model<any>> = {
  [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
    ? ModelRelations<TModel>[K] extends Relation<any, any>
      ? boolean | NestedIncludeInput<ModelRelations<TModel>[K]>
      : never
    : never;
};

/**
 * Omit input - specify fields to exclude
 */
export type OmitInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel> | RelationNames<TModel>]?: boolean;
};

// ===== NESTED SELECTION =====

/**
 * Extract the target model from a relation for nested selection
 */
export type ExtractRelationModelForSelect<TRelation> =
  TRelation extends Relation<infer TGetter, any>
    ? TGetter extends () => infer TModel
      ? TModel extends Model<any>
        ? TModel
        : never
      : never
    : never;

/**
 * Nested selection for relations
 */
export type NestedSelectInput<TRelation extends Relation<any, any>> = {
  select?: SelectInput<ExtractRelationModelForSelect<TRelation>>;
  include?: IncludeInput<ExtractRelationModelForSelect<TRelation>>;
  where?: WhereInput<ExtractRelationModelForSelect<TRelation>>;
  orderBy?: OrderByInput<ExtractRelationModelForSelect<TRelation>>;
  take?: number;
  skip?: number;
};

/**
 * Nested include for relations
 */
export type NestedIncludeInput<TRelation extends Relation<any, any>> = {
  select?: SelectInput<ExtractRelationModelForSelect<TRelation>>;
  include?: IncludeInput<ExtractRelationModelForSelect<TRelation>>;
  where?: WhereInput<ExtractRelationModelForSelect<TRelation>>;
  orderBy?: OrderByInput<ExtractRelationModelForSelect<TRelation>>;
  take?: number;
  skip?: number;
};

// ===== SELECTION VALIDATION =====

/**
 * Check if select and include are mutually exclusive
 */
export type ValidateSelectInclude<TArgs> = TArgs extends {
  select: any;
  include: any;
}
  ? never // Cannot have both select and include
  : TArgs;

/**
 * Ensure proper selection structure
 */
export type ValidSelection<
  TModel extends Model<any>,
  TArgs
> = ValidateSelectInclude<TArgs> extends never
  ? never
  : TArgs extends { select: infer TSelect }
  ? TSelect extends SelectInput<TModel>
    ? TArgs
    : never
  : TArgs extends { include: infer TInclude }
  ? TInclude extends IncludeInput<TModel>
    ? TArgs
    : never
  : TArgs;

// ===== SELECTION RESULT INFERENCE =====

/**
 * Infer the result type based on selection
 */
export type InferSelectResult<
  TModel extends Model<any>,
  TSelect extends SelectInput<TModel>
> = SimplifyDeep<
  {
    [K in keyof TSelect as TSelect[K] extends true
      ? K
      : never]: K extends FieldNames<TModel>
      ? K extends keyof ModelFields<TModel>
        ? ModelFields<TModel>[K] extends Field
          ? MapFieldType<ModelFields<TModel>[K]>
          : never
        : never
      : K extends RelationNames<TModel>
      ? K extends keyof ModelRelations<TModel>
        ? ModelRelations<TModel>[K] extends Relation<any, any>
          ? TSelect[K] extends NestedSelectInput<ModelRelations<TModel>[K]>
            ? InferNestedSelectResult<ModelRelations<TModel>[K], TSelect[K]>
            : InferRelationResult<ModelRelations<TModel>[K]>
          : never
        : never
      : never;
  } & (TSelect extends { _count: infer TCount }
    ? { _count: InferCountResult<TCount> }
    : {})
>;

export type InferCountResult<TCount> = {
  [K in keyof TCount]: number;
};

/**
 * Infer the result type based on include
 */
export type InferIncludeResult<
  TModel extends Model<any>,
  TInclude extends IncludeInput<TModel>
> = {
  // All scalar fields are included by default
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends Field
      ? MapFieldType<ModelFields<TModel>[K]>
      : never
    : never;
} & {
  // Relations are included based on include spec
  [K in keyof TInclude as TInclude[K] extends true | object
    ? K
    : never]: K extends RelationNames<TModel>
    ? K extends keyof ModelRelations<TModel>
      ? ModelRelations<TModel>[K] extends Relation<any, any>
        ? TInclude[K] extends NestedIncludeInput<ModelRelations<TModel>[K]>
          ? InferNestedIncludeResult<ModelRelations<TModel>[K], TInclude[K]>
          : InferRelationResult<ModelRelations<TModel>[K]>
        : never
      : never
    : never;
};

/**
 * Infer nested selection result
 */
export type InferNestedSelectResult<
  TRelation extends Relation<any, any>,
  TNested extends NestedSelectInput<TRelation>
> = TNested extends { select: infer TSelect }
  ? TSelect extends SelectInput<ExtractRelationModelForSelect<TRelation>>
    ? WrapRelationResult<
        TRelation,
        InferSelectResult<ExtractRelationModelForSelect<TRelation>, TSelect>
      >
    : never
  : TNested extends { include: infer TInclude }
  ? TInclude extends IncludeInput<ExtractRelationModelForSelect<TRelation>>
    ? WrapRelationResult<
        TRelation,
        InferIncludeResult<ExtractRelationModelForSelect<TRelation>, TInclude>
      >
    : never
  : WrapRelationResult<
      TRelation,
      InferDefaultSelectResult<ExtractRelationModelForSelect<TRelation>>
    >;

/**
 * Infer nested include result
 */
export type InferNestedIncludeResult<
  TRelation extends Relation<any, any>,
  TNested extends NestedIncludeInput<TRelation>
> = TNested extends { select: infer TSelect }
  ? TSelect extends SelectInput<ExtractRelationModelForSelect<TRelation>>
    ? WrapRelationResult<
        TRelation,
        InferSelectResult<ExtractRelationModelForSelect<TRelation>, TSelect>
      >
    : never
  : WrapRelationResult<
      TRelation,
      InferDefaultSelectResult<ExtractRelationModelForSelect<TRelation>>
    >;

/**
 * Wrap relation result based on cardinality
 */
export type WrapRelationResult<
  TRelation extends Relation<any, any>,
  TResult
> = TRelation extends Relation<any, infer TRelationType>
  ? TRelationType extends "oneToMany" | "manyToMany"
    ? TResult[]
    : TRelationType extends "oneToOne" | "manyToOne"
    ? TResult | null
    : never
  : never;

/**
 * Infer default result when no specific selection is provided
 */
export type InferDefaultSelectResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends Field
      ? MapFieldType<ModelFields<TModel>[K]>
      : never
    : never;
};

/**
 * Infer raw relation result
 */
export type InferRelationResult<TRelation extends Relation<any, any>> =
  WrapRelationResult<
    TRelation,
    InferDefaultSelectResult<ExtractRelationModelForSelect<TRelation>>
  >;

// ===== UTILITY TYPES =====

/**
 * Get all selectable fields from a model
 */
export type SelectableFields<TModel extends Model<any>> =
  | FieldNames<TModel>
  | RelationNames<TModel>;

/**
 * Check if a field/relation is selectable
 */
export type IsSelectable<
  TModel extends Model<any>,
  TKey extends string
> = TKey extends SelectableFields<TModel> ? true : false;

/**
 * Get scalar fields only
 */
export type ScalarSelectableFields<TModel extends Model<any>> =
  FieldNames<TModel>;

/**
 * Get relation fields only
 */
export type RelationSelectableFields<TModel extends Model<any>> =
  RelationNames<TModel>;

// ===== ADVANCED SELECTION PATTERNS =====

/**
 * Partial selection - allows optional selection of any field
 */
export type PartialSelectInput<TModel extends Model<any>> = Partial<
  SelectInput<TModel>
>;

/**
 * Deep selection - forces selection of nested relations
 */
export type DeepSelectInput<
  TModel extends Model<any>,
  TDepth extends number = 10
> = TDepth extends 0
  ? BaseSelectInput<TModel>
  : SelectInput<TModel> & {
      [K in RelationNames<TModel>]?: K extends keyof ModelRelations<TModel>
        ? ModelRelations<TModel>[K] extends Relation<any, any>
          ?
              | boolean
              | DeepSelectInput<
                  ExtractRelationModelForSelect<ModelRelations<TModel>[K]>,
                  Prev<TDepth>
                >
          : never
        : never;
    };

/**
 * Utility to decrement number type (for depth limiting)
 */
export type Prev<T extends number> = T extends 0
  ? 0
  : T extends 1
  ? 0
  : T extends 2
  ? 1
  : T extends 3
  ? 2
  : T extends 4
  ? 3
  : T extends 5
  ? 4
  : T extends 6
  ? 5
  : T extends 7
  ? 6
  : T extends 8
  ? 7
  : T extends 9
  ? 8
  : T extends 10
  ? 9
  : T extends 11
  ? 10
  : number;
