// Foundation Types: Model Extraction
// Extract type information from actual Model and BaseField classes

import type { Model } from "../../../schema/model.js";
import type { BaseField } from "../../../schema/fields/base.js";
import type { Relation } from "../../../schema/relation.js";

// Base type aliases for foundation
export type ModelDefinition = Model<any>;
export type FieldDefinition = BaseField<any>;
export type RelationDefinition = Relation<any, any>;

// Extract the generic parameter from Model<TFields> to get field definitions
export type ExtractModelFields<TModel extends Model<any>> =
  TModel extends Model<infer TFields> ? TFields : never;

// Helper to get field names that are actually BaseField instances
type ActualFieldNames<TModel extends Model<any>> = {
  [K in keyof ExtractModelFields<TModel>]: ExtractModelFields<TModel>[K] extends BaseField<any>
    ? K
    : never;
}[keyof ExtractModelFields<TModel>];

// Helper to get relation names that are actually Relation instances
type ActualRelationNames<TModel extends Model<any>> = {
  [K in keyof ExtractModelFields<TModel>]: ExtractModelFields<TModel>[K] extends Relation<
    any,
    any
  >
    ? K
    : never;
}[keyof ExtractModelFields<TModel>];

// Extract only BaseField instances from model definition
export type ExtractFields<TModel extends Model<any>> =
  ActualFieldNames<TModel> extends never
    ? {} // Return empty object if no fields
    : {
        [K in ActualFieldNames<TModel>]: ExtractModelFields<TModel>[K] extends BaseField<any>
          ? ExtractModelFields<TModel>[K]
          : never;
      };

// Extract only Relation instances from model definition
export type ExtractRelations<TModel extends Model<any>> =
  ActualRelationNames<TModel> extends never
    ? {} // Return empty object if no relations
    : {
        [K in ActualRelationNames<TModel>]: ExtractModelFields<TModel>[K] extends Relation<
          any,
          any
        >
          ? ExtractModelFields<TModel>[K]
          : never;
      };

// Extract the model name string
export type ExtractModelName<TModel extends Model<any>> =
  TModel extends Model<any> ? TModel["name"] : never;

// Utility to get field names only (excluding never values)
export type FieldNames<TModel extends Model<any>> = ActualFieldNames<TModel>;

// Utility to get relation names only (excluding never values)
export type RelationNames<TModel extends Model<any>> =
  ActualRelationNames<TModel>;

// Cleaner field extraction that removes never values
export type ModelFields<TModel extends Model<any>> = ExtractFields<TModel>;

// Cleaner relation extraction that removes never values
export type ModelRelations<TModel extends Model<any>> =
  ExtractRelations<TModel>;

// Check if model has any fields
export type HasFields<TModel extends Model<any>> =
  FieldNames<TModel> extends never ? false : true;

// Check if model has any relations
export type HasRelations<TModel extends Model<any>> =
  RelationNames<TModel> extends never ? false : true;

// Extract all property names (both fields and relations)
export type ModelPropertyNames<TModel extends Model<any>> =
  | FieldNames<TModel>
  | RelationNames<TModel>;
