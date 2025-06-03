import type { Model } from "@schema";
import type { WhereInput, WhereUniqueInput } from "../query/where-input.js";
import type { SelectInput, IncludeInput } from "../query/select-input.js";
import type { ValidateSelectInclude } from "../query/select-input.js";
import { UpdateInput } from "../query/update-input.js";
import { CreateInput } from "../query/create-input.js";

// ===== CREATE OPERATIONS =====

/**
 * Arguments for create operations
 */
export type CreateArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  data: CreateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for createMany operations
 */
export type CreateManyArgs<TModel extends Model<any>> = {
  data: CreateInput<TModel, false>[] | CreateInput<TModel, false>;
  skipDuplicates?: boolean;
};

// ===== UPDATE OPERATIONS =====

/**
 * Arguments for update operations
 */
export type UpdateArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  data: UpdateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for updateMany operations
 */
export type UpdateManyArgs<TModel extends Model<any>> = {
  where: WhereInput<TModel>;
  data: UpdateInput<TModel, false>;
};

// ===== UPSERT OPERATIONS =====

/**
 * Arguments for upsert operations
 */
export type UpsertArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  create: CreateInput<TModel>;
  update: UpdateInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

// ===== DELETE OPERATIONS =====

/**
 * Arguments for delete operations
 */
export type DeleteArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  where: WhereUniqueInput<TModel>;
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
}>;

/**
 * Arguments for deleteMany operations
 */
export type DeleteManyArgs<TModel extends Model<any>> = {
  where: WhereInput<TModel>;
};

/**
 * Extract mutation argument keys
 */
export const MutationArgKeys = [
  "data",
  "where",
  "create",
  "update",
  "select",
  "include",
  "skipDuplicates",
] as const;

export type MutationArgKeys = (typeof MutationArgKeys)[number];
