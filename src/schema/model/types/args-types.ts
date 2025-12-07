// Args Types
// Operation argument types for queries and mutations
// All types accept Model<any> directly and extract what they need internally

import type { Model } from "../model";
import type { ExtractFields, ScalarFieldKeys } from "./helpers";
import type {
  ModelWhereInput,
  ModelWhereUniqueInput,
  ModelWhereUniqueInputFull,
  ModelCreateInput,
  ModelUpdateInput,
  ModelOrderBy,
  ModelCountAggregateInput,
  ModelAvgAggregateInput,
  ModelMinMaxAggregateInput,
  ModelScalarWhereWithAggregates,
} from "./input-types";
import type {
  ModelSelectNested,
  ModelIncludeNested,
} from "./select-include-types";

// =============================================================================
// QUERY OPERATION ARGS
// =============================================================================

/**
 * FindMany args for a model - complete pagination and selection
 */
export type ModelFindManyArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
  orderBy?: ModelOrderBy<ExtractFields<M>> | ModelOrderBy<ExtractFields<M>>[];
  cursor?: ModelWhereUniqueInputFull<M>;
  take?: number;
  skip?: number;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
  distinct?: ScalarFieldKeys<ExtractFields<M>>[];
};

/**
 * FindFirst args (same as FindMany but returns single result)
 */
export type ModelFindFirstArgs<M extends Model<any>> = Omit<
  ModelFindManyArgs<M>,
  "where"
> & {
  where: ModelWhereInput<ExtractFields<M>>;
};

/**
 * FindUnique args - includes compound key support
 */
export type ModelFindUniqueArgs<M extends Model<any>> = {
  where: ModelWhereUniqueInputFull<M>;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
};

/**
 * Count args for a model - like Prisma's count operation
 */
export type ModelCountArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
  orderBy?: ModelOrderBy<ExtractFields<M>> | ModelOrderBy<ExtractFields<M>>[];
  cursor?: ModelWhereUniqueInputFull<M>;
  take?: number;
  skip?: number;
  select?: ModelCountAggregateInput<ExtractFields<M>>;
};

/**
 * Exist args for a model - lightweight check if records exist
 * Returns boolean instead of count for efficiency
 */
export type ModelExistArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
};

/**
 * Aggregate args for a model
 */
export type ModelAggregateArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
  orderBy?: ModelOrderBy<ExtractFields<M>> | ModelOrderBy<ExtractFields<M>>[];
  cursor?: ModelWhereUniqueInputFull<M>;
  take?: number;
  skip?: number;
  _count?: true | ModelCountAggregateInput<ExtractFields<M>>;
  _avg?: ModelAvgAggregateInput<ExtractFields<M>>;
  _sum?: ModelAvgAggregateInput<ExtractFields<M>>;
  _min?: ModelMinMaxAggregateInput<ExtractFields<M>>;
  _max?: ModelMinMaxAggregateInput<ExtractFields<M>>;
};

/**
 * GroupBy args for a model
 */
export type ModelGroupByArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
  orderBy?: ModelOrderBy<ExtractFields<M>> | ModelOrderBy<ExtractFields<M>>[];
  by: ScalarFieldKeys<ExtractFields<M>>[] | ScalarFieldKeys<ExtractFields<M>>;
  having?: ModelScalarWhereWithAggregates<ExtractFields<M>>;
  take?: number;
  skip?: number;
  _count?: true | ModelCountAggregateInput<ExtractFields<M>>;
  _avg?: ModelAvgAggregateInput<ExtractFields<M>>;
  _sum?: ModelAvgAggregateInput<ExtractFields<M>>;
  _min?: ModelMinMaxAggregateInput<ExtractFields<M>>;
  _max?: ModelMinMaxAggregateInput<ExtractFields<M>>;
};

// =============================================================================
// MUTATION OPERATION ARGS
// =============================================================================

/**
 * Create args
 */
export type ModelCreateArgs<M extends Model<any>> = {
  data: ModelCreateInput<ExtractFields<M>>;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
};

/**
 * Update args
 */
export type ModelUpdateArgs<M extends Model<any>> = {
  where: ModelWhereUniqueInput<ExtractFields<M>>;
  data: ModelUpdateInput<ExtractFields<M>>;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
};

/**
 * UpdateMany args
 */
export type ModelUpdateManyArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
  data: ModelUpdateInput<ExtractFields<M>>;
};

/**
 * Delete args
 */
export type ModelDeleteArgs<M extends Model<any>> = {
  where: ModelWhereUniqueInput<ExtractFields<M>>;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
};

/**
 * DeleteMany args
 */
export type ModelDeleteManyArgs<M extends Model<any>> = {
  where?: ModelWhereInput<ExtractFields<M>>;
};

/**
 * Upsert args
 */
export type ModelUpsertArgs<M extends Model<any>> = {
  where: ModelWhereUniqueInput<ExtractFields<M>>;
  create: ModelCreateInput<ExtractFields<M>>;
  update: ModelUpdateInput<ExtractFields<M>>;
  select?: ModelSelectNested<ExtractFields<M>>;
  include?: ModelIncludeNested<ExtractFields<M>>;
};
