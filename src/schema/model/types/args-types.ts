// Args Types
// Operation argument types for queries and mutations

import type { FieldRecord, ScalarFieldKeys } from "./helpers";
import type {
  ModelWhereInput,
  ModelWhereUniqueInput,
  ModelCreateInput,
  ModelUpdateInput,
  ModelOrderBy,
  ModelCountAggregateInput,
  ModelAvgAggregateInput,
  ModelMinMaxAggregateInput,
  ModelScalarWhereWithAggregates,
} from "./input-types";
import type { ModelSelectNested, ModelIncludeNested } from "./select-include-types";

// =============================================================================
// QUERY OPERATION ARGS
// =============================================================================

/**
 * FindMany args for a model - complete pagination and selection
 */
export type ModelFindManyArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
  orderBy?: ModelOrderBy<TFields> | ModelOrderBy<TFields>[];
  cursor?: ModelWhereUniqueInput<TFields>;
  take?: number;
  skip?: number;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
  distinct?: ScalarFieldKeys<TFields>[];
};

/**
 * FindFirst args (same as FindMany but returns single result)
 */
export type ModelFindFirstArgs<TFields extends FieldRecord> =
  ModelFindManyArgs<TFields>;

/**
 * FindUnique args
 */
export type ModelFindUniqueArgs<TFields extends FieldRecord> = {
  where: ModelWhereUniqueInput<TFields>;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
};

/**
 * Count args for a model - like Prisma's count operation
 */
export type ModelCountArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
  orderBy?: ModelOrderBy<TFields> | ModelOrderBy<TFields>[];
  cursor?: ModelWhereUniqueInput<TFields>;
  take?: number;
  skip?: number;
  select?: ModelCountAggregateInput<TFields>;
};

/**
 * Exist args for a model - lightweight check if records exist
 * Returns boolean instead of count for efficiency
 */
export type ModelExistArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
};

/**
 * Aggregate args for a model
 */
export type ModelAggregateArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
  orderBy?: ModelOrderBy<TFields> | ModelOrderBy<TFields>[];
  cursor?: ModelWhereUniqueInput<TFields>;
  take?: number;
  skip?: number;
  _count?: true | ModelCountAggregateInput<TFields>;
  _avg?: ModelAvgAggregateInput<TFields>;
  _sum?: ModelAvgAggregateInput<TFields>;
  _min?: ModelMinMaxAggregateInput<TFields>;
  _max?: ModelMinMaxAggregateInput<TFields>;
};

/**
 * GroupBy args for a model
 */
export type ModelGroupByArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
  orderBy?: ModelOrderBy<TFields> | ModelOrderBy<TFields>[];
  by: ScalarFieldKeys<TFields>[] | ScalarFieldKeys<TFields>;
  having?: ModelScalarWhereWithAggregates<TFields>;
  take?: number;
  skip?: number;
  _count?: true | ModelCountAggregateInput<TFields>;
  _avg?: ModelAvgAggregateInput<TFields>;
  _sum?: ModelAvgAggregateInput<TFields>;
  _min?: ModelMinMaxAggregateInput<TFields>;
  _max?: ModelMinMaxAggregateInput<TFields>;
};

// =============================================================================
// MUTATION OPERATION ARGS
// =============================================================================

/**
 * Create args
 */
export type ModelCreateArgs<TFields extends FieldRecord> = {
  data: ModelCreateInput<TFields>;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
};

/**
 * Update args
 */
export type ModelUpdateArgs<TFields extends FieldRecord> = {
  where: ModelWhereUniqueInput<TFields>;
  data: ModelUpdateInput<TFields>;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
};

/**
 * UpdateMany args
 */
export type ModelUpdateManyArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
  data: ModelUpdateInput<TFields>;
};

/**
 * Delete args
 */
export type ModelDeleteArgs<TFields extends FieldRecord> = {
  where: ModelWhereUniqueInput<TFields>;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
};

/**
 * DeleteMany args
 */
export type ModelDeleteManyArgs<TFields extends FieldRecord> = {
  where?: ModelWhereInput<TFields>;
};

/**
 * Upsert args
 */
export type ModelUpsertArgs<TFields extends FieldRecord> = {
  where: ModelWhereUniqueInput<TFields>;
  create: ModelCreateInput<TFields>;
  update: ModelUpdateInput<TFields>;
  select?: ModelSelectNested<TFields>;
  include?: ModelIncludeNested<TFields>;
};

