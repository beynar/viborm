// Query Type Definitions
// Based on specification: readme/2_query_builder.md

// Sort order
export type SortOrder = "asc" | "desc";

// Query mode for text searches
export type QueryMode = "default" | "insensitive";

// Null ordering
export type NullsOrder = "first" | "last";

// Sort order input with nulls positioning
export interface SortOrderInput {
  sort: SortOrder;
  nulls?: NullsOrder;
}

// Generic query arguments base
export interface QueryArgsBase {
  select?: any;
  include?: any;
}

// Find unique arguments
export interface FindUniqueArgs<TModel> extends QueryArgsBase {
  where: any; // WhereUniqueInput<TModel>
}

// Find first arguments
export interface FindFirstArgs<TModel> extends QueryArgsBase {
  where?: any; // WhereInput<TModel>
  orderBy?: any; // OrderByInput<TModel>
  cursor?: any; // WhereUniqueInput<TModel>
  take?: number;
  skip?: number;
  distinct?: string[]; // Field names
}

// Find many arguments
export interface FindManyArgs<TModel> extends FindFirstArgs<TModel> {}

// Create arguments
export interface CreateArgs<TModel> extends QueryArgsBase {
  data: any; // CreateInput<TModel>
}

// Create many arguments
export interface CreateManyArgs<TModel> {
  data: any[]; // CreateInput<TModel>[]
  skipDuplicates?: boolean;
}

// Update arguments
export interface UpdateArgs<TModel> extends QueryArgsBase {
  where: any; // WhereUniqueInput<TModel>
  data: any; // UpdateInput<TModel>
}

// Update many arguments
export interface UpdateManyArgs<TModel> {
  where?: any; // WhereInput<TModel>
  data: any; // UpdateManyMutationInput<TModel>
}

// Upsert arguments
export interface UpsertArgs<TModel> extends QueryArgsBase {
  where: any; // WhereUniqueInput<TModel>
  update: any; // UpdateInput<TModel>
  create: any; // CreateInput<TModel>
}

// Delete arguments
export interface DeleteArgs<TModel> extends QueryArgsBase {
  where: any; // WhereUniqueInput<TModel>
}

// Delete many arguments
export interface DeleteManyArgs<TModel> {
  where?: any; // WhereInput<TModel>
}

// Count arguments
export interface CountArgs<TModel> {
  where?: any; // WhereInput<TModel>
  orderBy?: any; // OrderByInput<TModel>
  cursor?: any; // WhereUniqueInput<TModel>
  take?: number;
  skip?: number;
  distinct?: string[];
  select?: any; // CountAggregateSelect<TModel>
}

// Aggregate arguments
export interface AggregateArgs<TModel> {
  where?: any; // WhereInput<TModel>
  orderBy?: any; // OrderByInput<TModel>
  cursor?: any; // WhereUniqueInput<TModel>
  take?: number;
  skip?: number;
  _count?: any; // CountAggregateSelect<TModel>
  _avg?: any; // AvgAggregateSelect<TModel>
  _sum?: any; // SumAggregateSelect<TModel>
  _min?: any; // MinAggregateSelect<TModel>
  _max?: any; // MaxAggregateSelect<TModel>
}

// Group by arguments
export interface GroupByArgs<TModel> {
  where?: any; // WhereInput<TModel>
  orderBy?: any; // OrderByWithAggregationInput<TModel>
  by: string[]; // Field names to group by
  having?: any; // ScalarWhereWithAggregatesInput<TModel>
  take?: number;
  skip?: number;
  _count?: any; // CountAggregateSelect<TModel>
  _avg?: any; // AvgAggregateSelect<TModel>
  _sum?: any; // SumAggregateSelect<TModel>
  _min?: any; // MinAggregateSelect<TModel>
  _max?: any; // MaxAggregateSelect<TModel>
}

// Raw query arguments
export interface RawQueryArgs {
  query: string;
  parameters?: any[];
}

// Batch payload for bulk operations
export interface BatchPayload {
  count: number;
}

// Result types
export type QueryResult<T, TArgs extends QueryArgsBase> = T;

export type FindUniqueResult<
  TModel,
  TArgs extends FindUniqueArgs<TModel>
> = TModel | null;

export type FindFirstResult<
  TModel,
  TArgs extends FindFirstArgs<TModel>
> = TModel | null;

export type FindManyResult<
  TModel,
  TArgs extends FindManyArgs<TModel>
> = TModel[];

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

// Database client interface
export interface DatabaseClient<TModel> {
  findUnique<TArgs extends FindUniqueArgs<TModel>>(
    args: TArgs
  ): Promise<FindUniqueResult<TModel, TArgs>>;

  findUniqueOrThrow<TArgs extends FindUniqueArgs<TModel>>(
    args: TArgs
  ): Promise<TModel>;

  findFirst<TArgs extends FindFirstArgs<TModel>>(
    args?: TArgs
  ): Promise<FindFirstResult<TModel, TArgs>>;

  findFirstOrThrow<TArgs extends FindFirstArgs<TModel>>(
    args?: TArgs
  ): Promise<TModel>;

  findMany<TArgs extends FindManyArgs<TModel>>(
    args?: TArgs
  ): Promise<FindManyResult<TModel, TArgs>>;

  create<TArgs extends CreateArgs<TModel>>(
    args: TArgs
  ): Promise<CreateResult<TModel, TArgs>>;

  createMany(args: CreateManyArgs<TModel>): Promise<CreateManyResult>;

  update<TArgs extends UpdateArgs<TModel>>(
    args: TArgs
  ): Promise<UpdateResult<TModel, TArgs>>;

  updateMany(args: UpdateManyArgs<TModel>): Promise<UpdateManyResult>;

  upsert<TArgs extends UpsertArgs<TModel>>(
    args: TArgs
  ): Promise<UpsertResult<TModel, TArgs>>;

  delete<TArgs extends DeleteArgs<TModel>>(
    args: TArgs
  ): Promise<DeleteResult<TModel, TArgs>>;

  deleteMany(args?: DeleteManyArgs<TModel>): Promise<DeleteManyResult>;

  count(args?: CountArgs<TModel>): Promise<CountResult>;

  aggregate(args?: AggregateArgs<TModel>): Promise<AggregateResult<TModel>>;

  groupBy(args: GroupByArgs<TModel>): Promise<GroupByResult<TModel>>;
}
