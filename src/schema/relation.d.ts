import type { RelationType, CascadeOptions, RelationValidator, ValidationResult } from "../types/index.js";
export declare class Relation<T = any> {
    relationType?: RelationType | undefined;
    targetModel?: (() => any) | undefined;
    onField?: string | undefined;
    refField?: string | undefined;
    cascadeOptions?: CascadeOptions | undefined;
    junctionTableName?: string | undefined;
    junctionFieldName?: string | undefined;
    constructor();
    one<TTarget>(target: () => TTarget): Relation<TTarget>;
    many<TTarget>(target: () => TTarget): Relation<TTarget[]>;
    on(fieldName: string): this;
    ref(fieldName: string): this;
    cascade(options: CascadeOptions): this;
    junctionTable(tableName: string): this;
    junctionField(fieldName: string): this;
    validate(data: T, ...validators: RelationValidator<T>[]): Promise<ValidationResult>;
    private clone;
    private copyPropertiesTo;
}
//# sourceMappingURL=relation.d.ts.map