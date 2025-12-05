// Types Index
// Re-exports all manual TypeScript types for model operations

// =============================================================================
// HELPERS
// =============================================================================
export type {
  FieldRecord,
  ScalarFieldKeys,
  RelationKeys,
  NumericFieldKeys,
  UniqueFieldKeys,
  OptionalCreateFieldKeys,
  RequiredCreateFieldKeys,
  ArrayFieldKeys,
  RelationGetter,
  GetterModel,
  GetRelationFields,
  GetRelationType,
  GetRelationOptional,
  InferFieldBase,
  InferFieldInput,
  InferFieldCreate,
  InferFieldFilter,
  InferFieldUpdate,
} from "./helpers";

// =============================================================================
// BASE TYPES
// =============================================================================
export type {
  Simplify,
  AtLeast,
  SortOrder,
  NullsOrder,
  SortOrderInput,
} from "./base-types";

// =============================================================================
// INPUT TYPES
// =============================================================================
export type {
  ModelCreateInput,
  ModelCreateManyInput,
  CreateManyEnvelope,
  ModelWhereInput,
  ModelWhereUniqueInput,
  ModelUpdateInput,
  ModelSelect,
  ModelInclude,
  ModelOrderBy,
  ModelCountAggregateInput,
  ModelAvgAggregateInput,
  ModelMinMaxAggregateInput,
  ModelScalarWhereWithAggregates,
} from "./input-types";

// =============================================================================
// RELATION TYPES
// =============================================================================
export type {
  ToOneCreateInput,
  ToManyCreateInput,
  ToOneUpdateInputRequired,
  ToOneUpdateInputOptional,
  ToOneUpdateInput,
  ToManyUpdateInput,
  ToOneWhereInput,
  ToManyWhereInput,
  RelationCreateInput,
  RelationUpdateInput,
  RelationWhereInput,
} from "./relation-types";

// =============================================================================
// ARGS TYPES
// =============================================================================
export type {
  ModelFindManyArgs,
  ModelFindFirstArgs,
  ModelFindUniqueArgs,
  ModelCountArgs,
  ModelExistArgs,
  ModelAggregateArgs,
  ModelGroupByArgs,
  ModelCreateArgs,
  ModelUpdateArgs,
  ModelUpdateManyArgs,
  ModelDeleteArgs,
  ModelDeleteManyArgs,
  ModelUpsertArgs,
} from "./args-types";

// =============================================================================
// AGGREGATE TYPES
// =============================================================================
export type {
  CountAggregateResult,
  NumericAggregateResult,
  MinMaxAggregateResult,
  AggregateResult,
  CleanAggregateResult,
  HavingAggregateFilter,
  CountHavingInput,
  NumericHavingInput,
  MinMaxHavingInput,
  ModelHavingInput,
  GroupByResult,
  GroupByResults,
} from "./aggregate-types";

// =============================================================================
// SELECT/INCLUDE TYPES
// =============================================================================
export type {
  ScalarSelect,
  ToOneSelectArgs,
  ToManySelectArgs,
  RelationSelectValue,
  ModelSelectNested,
  ToOneIncludeArgs,
  ToManyIncludeArgs,
  RelationIncludeValue,
  ModelIncludeNested,
  FindManyArgsNested,
  FindUniqueArgsNested,
  FindFirstArgsNested,
} from "./select-include-types";

// =============================================================================
// UNCHECKED TYPES
// =============================================================================
export type {
  ForeignKeyFields,
  ForeignKeyFieldsOptional,
  ModelUncheckedCreateInput,
  ModelUncheckedUpdateInput,
  ModelUncheckedCreateManyInput,
  ModelUncheckedUpdateManyInput,
} from "./unchecked-types";

export {
  isForeignKeyField,
  getRelationFromFk,
  getFkFromRelation,
} from "./unchecked-types";

// =============================================================================
// RESULT TYPES
// =============================================================================
export type {
  ModelBaseResult,
  RelationResult,
  IncludedRelationResult,
  SelectResult,
  IncludeResult,
  InferResult,
  BatchPayload,
  CountResultType,
  AggregateResultType,
  GroupByResultType,
} from "./result-types";

