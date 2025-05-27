export type IndexType = "btree" | "hash" | "gin" | "gist";
export interface IndexOptions {
    name?: string;
    unique?: boolean;
    type?: IndexType;
    where?: string;
}
export interface IndexDefinition {
    fields: string[];
    options: IndexOptions;
}
export interface UniqueConstraintOptions {
    name?: string;
}
export interface UniqueConstraintDefinition {
    fields: string[];
    options: UniqueConstraintOptions;
}
export interface ModelOptions {
    tableName?: string;
    comment?: string;
    engine?: string;
    charset?: string;
}
export interface ModelMetadata {
    name: string;
    tableName?: string;
    fields: Record<string, any>;
    relations: Record<string, any>;
    indexes: IndexDefinition[];
    uniqueConstraints: UniqueConstraintDefinition[];
    validators: Array<any>;
}
export interface ModelDefinition {
    name: string;
    fields: Record<string, any>;
    tableName?: string;
    indexes?: IndexDefinition[];
    uniqueConstraints?: UniqueConstraintDefinition[];
    options?: ModelOptions;
}
import type { BaseField, Field } from "../schema/field.js";
import type { Relation } from "../schema/relation.js";
export type ScalarFields<TModel extends Record<string, any>> = {
    [K in keyof TModel]: TModel[K] extends BaseField<any> ? K : never;
}[keyof TModel];
export type RelationFields<TModel extends Record<string, any>> = {
    [K in keyof TModel]: TModel[K] extends Relation<any> ? K : never;
}[keyof TModel];
export type ModelFieldNames<TModel extends Record<string, any>> = keyof TModel & string;
export type ModelType<TFields extends Record<string, Field | Relation<any>>> = {
    [K in keyof TFields]: TFields[K] extends BaseField<infer T> ? T : TFields[K] extends Relation<infer R> ? R : never;
};
export type ModelScalars<TFields extends Record<string, Field | Relation<any>>> = {
    [K in keyof TFields as TFields[K] extends BaseField<any> ? K : never]: TFields[K] extends BaseField<infer T> ? T : never;
};
export type ModelRelations<TFields extends Record<string, Field | Relation<any>>> = {
    [K in keyof TFields as TFields[K] extends Relation<any> ? K : never]: TFields[K] extends Relation<infer R> ? R : never;
};
export interface ModelPayload<T> {
    name: string;
    scalars: T;
    objects: Record<string, any>;
    composites: Record<string, any>;
}
export type ModelSelect<TModel extends Record<string, any>> = {
    [K in keyof TModel]?: boolean;
};
export type ModelInclude<TModel extends Record<string, any>> = {
    [K in RelationFields<TModel>]?: boolean | {
        select?: any;
        include?: any;
        where?: any;
        orderBy?: any;
        take?: number;
        skip?: number;
    };
};
export type FieldConstraints<TFields extends Record<string, Field | Relation<any>>> = {
    [K in ScalarFields<TFields>]: string;
};
//# sourceMappingURL=models.d.ts.map