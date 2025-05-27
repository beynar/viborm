import type { RelationType, CascadeOptions, RelationValidator, ValidationResult } from "../types/index.js";
export declare class Relation<T = any> {
    private relationType?;
    private targetModel?;
    private onField?;
    private refField?;
    private cascadeOptions?;
    private junctionTableName?;
    private junctionFieldName?;
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
    "~getRelationType"(): RelationType | undefined;
    "~getTargetModel"(): (() => any) | undefined;
    "~getOnField"(): string | undefined;
    "~getRefField"(): string | undefined;
    "~getCascadeOptions"(): CascadeOptions | undefined;
    "~getJunctionTableName"(): string | undefined;
    "~getJunctionFieldName"(): string | undefined;
    private copyPropertiesTo;
}
//# sourceMappingURL=relation.d.ts.map