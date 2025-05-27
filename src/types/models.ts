// Model Type Definitions
// Based on specification: readme/1.1_model_class.md

// Index types and options
export type IndexType = "btree" | "hash" | "gin" | "gist";

export interface IndexOptions {
  name?: string;
  unique?: boolean;
  type?: IndexType;
  where?: string; // For partial indexes (PostgreSQL)
}

export interface IndexDefinition {
  fields: string[];
  options: IndexOptions;
}

// Unique constraint types
export interface UniqueConstraintOptions {
  name?: string;
}

export interface UniqueConstraintDefinition {
  fields: string[];
  options: UniqueConstraintOptions;
}

// Model configuration options
export interface ModelOptions {
  tableName?: string;
  comment?: string;
  engine?: string; // MySQL specific
  charset?: string; // MySQL specific
}

// Model metadata for introspection
export interface ModelMetadata {
  name: string;
  tableName?: string;
  fields: Record<string, any>;
  relations: Record<string, any>;
  indexes: IndexDefinition[];
  uniqueConstraints: UniqueConstraintDefinition[];
  validators: Array<any>;
}

// Model definition structure
export interface ModelDefinition {
  name: string;
  fields: Record<string, any>;
  tableName?: string;
  indexes?: IndexDefinition[];
  uniqueConstraints?: UniqueConstraintDefinition[];
  options?: ModelOptions;
}

// Import BaseField and Relation types for proper type inference
import type { BaseField, Field } from "../schema/field.js";
import { Model } from "../schema/model.js";
import type { Relation } from "../schema/relation.js";
import { BaseFieldType, FieldState, Nullable } from "./index.js";

// Type for extracting scalar fields from a model
export type ScalarFields<TModel extends Record<string, any>> = {
  [K in keyof TModel]: TModel[K] extends BaseField<any> ? K : never;
}[keyof TModel];

// Type for extracting relation fields from a model
export type RelationFields<TModel extends Record<string, any>> = {
  [K in keyof TModel]: TModel[K] extends Relation<any> ? K : never;
}[keyof TModel];

// Type for model field names
export type ModelFieldNames<TModel extends Record<string, any>> = keyof TModel &
  string;

// Type for creating a model type from field definitions
export type ModelType<
  TFields extends Record<string, Field | Relation<any, any>>
> = {
  [K in keyof TFields]: TFields[K]["infer"];
};

// Extract the scalar type from a model type (without relations)
export type ModelScalars<
  TFields extends Record<string, Field | Relation<any, any>>
> = {
  [K in keyof TFields as TFields[K] extends BaseField<any>
    ? K
    : never]: TFields[K] extends BaseField<infer T> ? T : never;
};

// Model payload type for internal use
export interface ModelPayload<T> {
  name: string;
  scalars: T;
  objects: Record<string, any>;
  composites: Record<string, any>;
}

// Model select type
export type ModelSelect<TModel extends Record<string, any>> = {
  [K in keyof TModel]?: boolean;
};

// Model include type for relations
export type ModelInclude<TModel extends Record<string, any>> = {
  [K in RelationFields<TModel>]?:
    | boolean
    | {
        select?: any;
        include?: any;
        where?: any;
        orderBy?: any;
        take?: number;
        skip?: number;
      };
};

// Type-safe field constraint definitions
export type FieldConstraints<
  TFields extends Record<string, Field | Relation<any, any>>
> = {
  [K in ScalarFields<TFields>]: string;
};
