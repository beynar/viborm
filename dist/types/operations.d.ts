export interface CreateInputBase<TModel> {
}
export interface UncheckedCreateInputBase<TModel> {
}
export interface UpdateInputBase<TModel> {
}
export interface UncheckedUpdateInputBase<TModel> {
}
export interface UpdateManyMutationInputBase<TModel> {
}
export interface UpsertInputBase<TModel> {
    update: UpdateInputBase<TModel>;
    create: CreateInputBase<TModel>;
}
export interface WhereInputBase<TModel> {
    AND?: TModel | TModel[];
    OR?: TModel[];
    NOT?: TModel | TModel[];
}
export interface WhereUniqueInputBase<TModel> {
}
export interface OrderByInputBase<TModel> {
}
export interface OrderByWithRelationInputBase<TModel> {
}
export interface OrderByWithAggregationInputBase<TModel> {
}
export interface ScalarWhereWithAggregatesInputBase<TModel> {
    AND?: TModel | TModel[];
    OR?: TModel[];
    NOT?: TModel | TModel[];
}
export interface CountAggregateInputBase<TModel> {
    [key: string]: boolean;
}
export interface CountAggregateInputWithAll<TModel> {
    [key: string]: boolean | undefined;
    _all?: boolean;
}
export interface CountAggregateOutputBase<TModel> {
    [key: string]: number;
    _all: number;
}
export interface MinAggregateInputBase<TModel> {
    [key: string]: boolean;
}
export interface MinAggregateOutputBase<TModel> {
    [key: string]: any;
}
export interface MaxAggregateInputBase<TModel> {
    [key: string]: boolean;
}
export interface MaxAggregateOutputBase<TModel> {
    [key: string]: any;
}
export interface SumAggregateInputBase<TModel> {
    [key: string]: boolean;
}
export interface SumAggregateOutputBase<TModel> {
    [key: string]: number | bigint | null;
}
export interface AvgAggregateInputBase<TModel> {
    [key: string]: boolean;
}
export interface AvgAggregateOutputBase<TModel> {
    [key: string]: number | null;
}
export interface AggregateResultBase<TModel> {
    _count?: CountAggregateOutputBase<TModel>;
    _min?: MinAggregateOutputBase<TModel>;
    _max?: MaxAggregateOutputBase<TModel>;
    _sum?: SumAggregateOutputBase<TModel>;
    _avg?: AvgAggregateOutputBase<TModel>;
}
export interface BatchPayload {
    count: number;
}
export declare class NotFoundError extends Error {
    constructor(message: string);
}
export declare class UniqueConstraintViolationError extends Error {
    field?: string | undefined;
    constructor(message: string, field?: string | undefined);
}
export declare class ForeignKeyConstraintViolationError extends Error {
    field?: string | undefined;
    constructor(message: string, field?: string | undefined);
}
export interface TransactionOptions {
    isolationLevel?: "READ_UNCOMMITTED" | "READ_COMMITTED" | "REPEATABLE_READ" | "SERIALIZABLE";
    timeout?: number;
    maxWait?: number;
}
export type TransactionClient = any;
export interface RawQueryResult<T = any> {
    rows: T[];
    rowCount: number;
    fields: Array<{
        name: string;
        type: string;
    }>;
}
export interface ConnectionConfig {
    host: string;
    port: number;
    database: string;
    username: string;
    password: string;
    ssl?: boolean | object;
    poolSize?: number;
    connectionTimeout?: number;
}
export interface ClientOptions {
    connection: ConnectionConfig;
    debug?: boolean;
    errorFormat?: "pretty" | "colorless" | "minimal";
}
export interface OperationContext {
    model?: string;
    operation?: string;
    args?: any;
    query?: string;
    timestamp?: Date;
}
//# sourceMappingURL=operations.d.ts.map