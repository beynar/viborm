import { BaseField, type Field } from "./field.js";
import { Relation } from "./relation.js";
import type { IndexDefinition, UniqueConstraintDefinition, ModelValidator, ValidationResult, IndexOptions, UniqueConstraintOptions, ModelType } from "../types/index.js";
export declare class Model<TFields extends Record<string, Field | Relation<any>> = {}> {
    private name;
    private fieldDefinitions;
    private fields;
    private relations;
    private tableName?;
    private indexes;
    private uniqueConstraints;
    constructor(name: string, fieldDefinitions: TFields);
    private separateFieldsAndRelations;
    map(tableName: string): this;
    index(fields: string | string[], options?: IndexOptions): this;
    unique(fields: string | string[], options?: UniqueConstraintOptions): this;
    validate(data: ModelType<TFields>, ...validators: ModelValidator<ModelType<TFields>>[]): Promise<ValidationResult>;
    "~getFields"(): Record<string, BaseField<any>>;
    "~getRelations"(): Record<string, Relation<any>>;
    "~getIndexes"(): IndexDefinition[];
    "~getUniqueConstraints"(): UniqueConstraintDefinition[];
    "~getTableName"(): string;
    "~getName"(): string;
    get infer(): ModelType<TFields>;
}
//# sourceMappingURL=model.d.ts.map