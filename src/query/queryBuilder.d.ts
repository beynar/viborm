import type { FindUniqueArgs, FindFirstArgs, FindManyArgs, CreateArgs, CreateManyArgs, UpdateArgs, UpdateManyArgs, UpsertArgs, DeleteArgs, DeleteManyArgs, CountArgs, AggregateArgs, GroupByArgs, BatchPayload, DatabaseClient } from "../types/index.js";
export declare class QueryBuilder<TModel> implements DatabaseClient<TModel> {
    private adapter;
    private modelName;
    constructor(adapter: any, // Will be typed when adapter is implemented
    modelName: string);
    findUnique<TArgs extends FindUniqueArgs<TModel>>(args: TArgs): Promise<TModel | null>;
    findUniqueOrThrow<TArgs extends FindUniqueArgs<TModel>>(args: TArgs): Promise<TModel>;
    findFirst<TArgs extends FindFirstArgs<TModel>>(args?: TArgs): Promise<TModel | null>;
    findFirstOrThrow<TArgs extends FindFirstArgs<TModel>>(args?: TArgs): Promise<TModel>;
    findMany<TArgs extends FindManyArgs<TModel>>(args?: TArgs): Promise<TModel[]>;
    create<TArgs extends CreateArgs<TModel>>(args: TArgs): Promise<TModel>;
    createMany(args: CreateManyArgs<TModel>): Promise<BatchPayload>;
    update<TArgs extends UpdateArgs<TModel>>(args: TArgs): Promise<TModel>;
    updateMany(args: UpdateManyArgs<TModel>): Promise<BatchPayload>;
    upsert<TArgs extends UpsertArgs<TModel>>(args: TArgs): Promise<TModel>;
    delete<TArgs extends DeleteArgs<TModel>>(args: TArgs): Promise<TModel>;
    deleteMany(args?: DeleteManyArgs<TModel>): Promise<BatchPayload>;
    count(args?: CountArgs<TModel>): Promise<number>;
    aggregate(args?: AggregateArgs<TModel>): Promise<any>;
    groupBy(args: GroupByArgs<TModel>): Promise<any[]>;
    raw(query: string, parameters?: any[]): Promise<any>;
    private buildWhereClause;
    private buildSelectQuery;
    private buildInsertQuery;
    private buildUpdateQuery;
    private buildDeleteQuery;
}
//# sourceMappingURL=queryBuilder.d.ts.map