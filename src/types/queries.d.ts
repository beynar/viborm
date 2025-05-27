export type SortOrder = "asc" | "desc";
export type QueryMode = "default" | "insensitive";
export type NullsOrder = "first" | "last";
export interface SortOrderInput {
    sort: SortOrder;
    nulls?: NullsOrder;
}
export interface QueryArgsBase {
    select?: any;
    include?: any;
}
export interface FindUniqueArgs<TModel> extends QueryArgsBase {
    where: any;
}
export interface FindFirstArgs<TModel> extends QueryArgsBase {
    where?: any;
    orderBy?: any;
    cursor?: any;
    take?: number;
    skip?: number;
    distinct?: string[];
}
export interface FindManyArgs<TModel> extends FindFirstArgs<TModel> {
}
export interface CreateArgs<TModel> extends QueryArgsBase {
    data: any;
}
export interface CreateManyArgs<TModel> {
    data: any[];
    skipDuplicates?: boolean;
}
export interface UpdateArgs<TModel> extends QueryArgsBase {
    where: any;
    data: any;
}
export interface UpdateManyArgs<TModel> {
    where?: any;
    data: any;
}
export interface UpsertArgs<TModel> extends QueryArgsBase {
    where: any;
    update: any;
    create: any;
}
export interface DeleteArgs<TModel> extends QueryArgsBase {
    where: any;
}
export interface DeleteManyArgs<TModel> {
    where?: any;
}
export interface CountArgs<TModel> {
    where?: any;
    orderBy?: any;
    cursor?: any;
    take?: number;
    skip?: number;
    distinct?: string[];
    select?: any;
}
export interface AggregateArgs<TModel> {
    where?: any;
    orderBy?: any;
    cursor?: any;
    take?: number;
    skip?: number;
    _count?: any;
    _avg?: any;
    _sum?: any;
    _min?: any;
    _max?: any;
}
export interface GroupByArgs<TModel> {
    where?: any;
    orderBy?: any;
    by: string[];
    having?: any;
    take?: number;
    skip?: number;
    _count?: any;
    _avg?: any;
    _sum?: any;
    _min?: any;
    _max?: any;
}
export interface RawQueryArgs {
    query: string;
    parameters?: any[];
}
export interface BatchPayload {
    count: number;
}
export type QueryResult<T, TArgs extends QueryArgsBase> = T;
export type FindUniqueResult<TModel, TArgs extends FindUniqueArgs<TModel>> = TModel | null;
export type FindFirstResult<TModel, TArgs extends FindFirstArgs<TModel>> = TModel | null;
export type FindManyResult<TModel, TArgs extends FindManyArgs<TModel>> = TModel[];
export type CreateResult<TModel, TArgs extends CreateArgs<TModel>> = TModel;
export type CreateManyResult = BatchPayload;
export type UpdateResult<TModel, TArgs extends UpdateArgs<TModel>> = TModel;
export type UpdateManyResult = BatchPayload;
export type UpsertResult<TModel, TArgs extends UpsertArgs<TModel>> = TModel;
export type DeleteResult<TModel, TArgs extends DeleteArgs<TModel>> = TModel;
export type DeleteManyResult = BatchPayload;
export type CountResult = number;
export type AggregateResult<TModel> = {
    _count?: any;
    _avg?: any;
    _sum?: any;
    _min?: any;
    _max?: any;
};
export type GroupByResult<TModel> = Array<{
    [key: string]: any;
    _count?: any;
    _avg?: any;
    _sum?: any;
    _min?: any;
    _max?: any;
}>;
export interface DatabaseClient<TModel> {
    findUnique<TArgs extends FindUniqueArgs<TModel>>(args: TArgs): Promise<FindUniqueResult<TModel, TArgs>>;
    findUniqueOrThrow<TArgs extends FindUniqueArgs<TModel>>(args: TArgs): Promise<TModel>;
    findFirst<TArgs extends FindFirstArgs<TModel>>(args?: TArgs): Promise<FindFirstResult<TModel, TArgs>>;
    findFirstOrThrow<TArgs extends FindFirstArgs<TModel>>(args?: TArgs): Promise<TModel>;
    findMany<TArgs extends FindManyArgs<TModel>>(args?: TArgs): Promise<FindManyResult<TModel, TArgs>>;
    create<TArgs extends CreateArgs<TModel>>(args: TArgs): Promise<CreateResult<TModel, TArgs>>;
    createMany(args: CreateManyArgs<TModel>): Promise<CreateManyResult>;
    update<TArgs extends UpdateArgs<TModel>>(args: TArgs): Promise<UpdateResult<TModel, TArgs>>;
    updateMany(args: UpdateManyArgs<TModel>): Promise<UpdateManyResult>;
    upsert<TArgs extends UpsertArgs<TModel>>(args: TArgs): Promise<UpsertResult<TModel, TArgs>>;
    delete<TArgs extends DeleteArgs<TModel>>(args: TArgs): Promise<DeleteResult<TModel, TArgs>>;
    deleteMany(args?: DeleteManyArgs<TModel>): Promise<DeleteManyResult>;
    count(args?: CountArgs<TModel>): Promise<CountResult>;
    aggregate(args?: AggregateArgs<TModel>): Promise<AggregateResult<TModel>>;
    groupBy(args: GroupByArgs<TModel>): Promise<GroupByResult<TModel>>;
}
//# sourceMappingURL=queries.d.ts.map