import { BaseField, type Field } from "./field.js";
import { Relation } from "./relation.js";
import type { IndexDefinition, UniqueConstraintDefinition, ModelValidator, ValidationResult, IndexOptions, UniqueConstraintOptions, ModelType } from "../types/index.js";
export declare class Model<TFields extends Record<string, Field | Relation<any>> = {}> {
    private fieldDefinitions;
    readonly fields: Map<string, BaseField<any>>;
    readonly relations: Map<string, Relation<any>>;
    readonly name: string;
    tableName?: string;
    readonly indexes: IndexDefinition[];
    readonly uniqueConstraints: UniqueConstraintDefinition[];
    constructor(name: string, fieldDefinitions: TFields);
    private separateFieldsAndRelations;
    map(tableName: string): this;
    index(fields: string | string[], options?: IndexOptions): this;
    unique(fields: string | string[], options?: UniqueConstraintOptions): this;
    validate(data: ModelType<TFields>, ...validators: ModelValidator<ModelType<TFields>>[]): Promise<ValidationResult>;
    get infer(): ModelType<TFields>;
}
//# sourceMappingURL=model.d.ts.map