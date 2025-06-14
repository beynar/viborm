// Find Operation Arguments
// Type-safe argument interfaces for find operations

import type { Model, BaseField } from "@schema";
import type { WhereInput, WhereUniqueInput } from "../query/where-input.js";
import type {
  SelectInput,
  IncludeInput,
  ValidateSelectInclude,
} from "../query/select-input.js";
import type {
  OrderByInput,
  OrderByArrayInput,
} from "../query/orderby-input.js";
import type {
  FieldNames,
  ModelFields,
  MapFieldType,
  ActualPluralRelationNames,
} from "../foundation/index.js";

// ===== CORE FIND ARGUMENTS =====

/**
 * Base arguments for any find operation
 */
export type BaseFindArgs<TModel extends Model<any>> = {
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
  where?: WhereInput<TModel>;
  orderBy?: OrderByInput<TModel> | OrderByArrayInput<TModel>;
};

/**
 * Arguments for findMany operations
 */
export type FindManyArgs<TModel extends Model<any>> = ValidateSelectInclude<
  BaseFindArgs<TModel> & {
    take?: number;
    skip?: number;
    cursor?: WhereUniqueInput<TModel>;
    distinct?: DistinctInput<TModel>;
  }
>;

/**
 * Arguments for findUnique operations
 */
export type FindUniqueArgs<TModel extends Model<any>> = ValidateSelectInclude<{
  select?: SelectInput<TModel>;
  include?: IncludeInput<TModel>;
  where: WhereUniqueInput<TModel>;
}>;

/**
 * Arguments for findUniqueOrThrow operations
 */
export type FindUniqueOrThrowArgs<TModel extends Model<any>> =
  FindUniqueArgs<TModel>;

/**
 * Arguments for findFirst operations
 */
export type FindFirstArgs<TModel extends Model<any>> = ValidateSelectInclude<
  BaseFindArgs<TModel> & {
    take?: number;
    skip?: number;
    cursor?: WhereUniqueInput<TModel>;
    distinct?: DistinctInput<TModel>;
  }
>;

/**
 * Arguments for findFirstOrThrow operations
 */
export type FindFirstOrThrowArgs<TModel extends Model<any>> =
  FindFirstArgs<TModel>;

/**
 * Cursor-based pagination arguments
 */
export type CursorPaginationArgs<TModel extends Model<any>> = {
  cursor?: WhereUniqueInput<TModel>;
  take?: number;
  skip?: number;
};

/**
 * Offset-based pagination arguments
 */
export type OffsetPaginationArgs = {
  take?: number;
  skip?: number;
};

/**
 * Combined pagination arguments
 */
export type PaginationArgs<TModel extends Model<any>> =
  | CursorPaginationArgs<TModel>
  | OffsetPaginationArgs;

// ===== DISTINCT ARGUMENTS =====

/**
 * Distinct field selection
 */
export type DistinctInput<TModel extends Model<any>> = Array<
  keyof SelectInput<TModel>
>;

// ===== FILTERING ARGUMENTS =====

/**
 * Enhanced where arguments with additional filters
 */
export type EnhancedWhereArgs<TModel extends Model<any>> = {
  where?: WhereInput<TModel>;
  AND?: WhereInput<TModel>[];
  OR?: WhereInput<TModel>[];
  NOT?: WhereInput<TModel> | WhereInput<TModel>[];
};

/**
 * Search arguments for full-text search
 */
export type SearchArgs<TModel extends Model<any>> = {
  search?: {
    query: string;
    fields?: Array<keyof SelectInput<TModel>>;
    mode?: "natural" | "boolean" | "query_expansion";
  };
};

// ===== RELATION ARGUMENTS =====

// ===== ADVANCED FIND ARGUMENTS =====

/**
 * Arguments for aggregation operations
 */
export type AggregateArgs<TModel extends Model<any>> = {
  where?: WhereInput<TModel>;
  orderBy?: OrderByInput<TModel>;
  cursor?: WhereUniqueInput<TModel>;
  take?: number;
  skip?: number;
  _count?: boolean | CountSelectInput<TModel>;
  _avg?: AvgSelectInput<TModel>;
  _sum?: SumSelectInput<TModel>;
  _min?: MinSelectInput<TModel>;
  _max?: MaxSelectInput<TModel>;
};

/**
 * Arguments for groupBy operations
 */
export type GroupByArgs<TModel extends Model<any>> = {
  where?: WhereInput<TModel>;
  orderBy?: OrderByInput<TModel>;
  by: Array<keyof SelectInput<TModel>>;
  having?: HavingInput<TModel>;
  take?: number;
  skip?: number;
  _count?: boolean | CountSelectInput<TModel>;
  _avg?: AvgSelectInput<TModel>;
  _sum?: SumSelectInput<TModel>;
  _min?: MinSelectInput<TModel>;
  _max?: MaxSelectInput<TModel>;
};

/**
 * Arguments for count operations
 */
export type CountArgs<TModel extends Model<any>> = {
  where?: WhereInput<TModel>;
  orderBy?: OrderByInput<TModel>;
  cursor?: WhereUniqueInput<TModel>;
  take?: number;
  skip?: number;
  select?: CountSelectInput<TModel>;
};

// ===== AGGREGATION SELECTION TYPES =====

/**
 * Count selection input
 */
export type CountSelectInput<TModel extends Model<any>> = {
  [K in ActualPluralRelationNames<TModel>]?:
    | boolean
    | {
        where: WhereInput<TModel>;
      };
};

/**
 * Average selection input (for numeric fields only)
 */
export type AvgSelectInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? K
        : never
      : never
    : never]?: boolean;
};

/**
 * Sum selection input (for numeric fields only)
 */
export type SumSelectInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? K
        : never
      : never
    : never]?: boolean;
};

/**
 * Min selection input (for comparable fields)
 */
export type MinSelectInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number | string | Date
        ? K
        : never
      : never
    : never]?: boolean;
};

/**
 * Max selection input (for comparable fields)
 */
export type MaxSelectInput<TModel extends Model<any>> = {
  [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number | string | Date
        ? K
        : never
      : never
    : never]?: boolean;
};

/**
 * Having clause for groupBy operations
 */
export type HavingInput<TModel extends Model<any>> = {
  AND?: HavingInput<TModel>[];
  OR?: HavingInput<TModel>[];
  NOT?: HavingInput<TModel>;
  // Aggregation filters
  _count?: {
    [K in FieldNames<TModel>]?:
      | number
      | {
          gte?: number;
          gt?: number;
          lte?: number;
          lt?: number;
          equals?: number;
        };
  };
  _avg?: {
    [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
      ? ModelFields<TModel>[K] extends BaseField<any>
        ? MapFieldType<ModelFields<TModel>[K]> extends number
          ? K
          : never
        : never
      : never]?:
      | number
      | {
          gte?: number;
          gt?: number;
          lte?: number;
          lt?: number;
          equals?: number;
        };
  };
  _sum?: {
    [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
      ? ModelFields<TModel>[K] extends BaseField<any>
        ? MapFieldType<ModelFields<TModel>[K]> extends number
          ? K
          : never
        : never
      : never]?:
      | number
      | {
          gte?: number;
          gt?: number;
          lte?: number;
          lt?: number;
          equals?: number;
        };
  };
  _min?: {
    [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
      ? ModelFields<TModel>[K] extends BaseField<any>
        ? MapFieldType<ModelFields<TModel>[K]> extends number | string | Date
          ? K
          : never
        : never
      : never]?:
      | any
      | { gte?: any; gt?: any; lte?: any; lt?: any; equals?: any };
  };
  _max?: {
    [K in FieldNames<TModel> as K extends keyof ModelFields<TModel>
      ? ModelFields<TModel>[K] extends BaseField<any>
        ? MapFieldType<ModelFields<TModel>[K]> extends number | string | Date
          ? K
          : never
        : never
      : never]?:
      | any
      | { gte?: any; gt?: any; lte?: any; lt?: any; equals?: any };
  };
};

// ===== UTILITY TYPES =====

/**
 * Extract valid find argument keys
 */
export type FindArgKeys =
  | "select"
  | "include"
  | "where"
  | "orderBy"
  | "take"
  | "skip"
  | "cursor"
  | "distinct";

// ================================
// EXIST OPERATION ARGS
// ================================

/**
 * Arguments for exist operation
 *
 * The exist operation is a lightweight way to check if any records
 * exist that match the given WHERE conditions. It returns a boolean
 * instead of counting records, making it more efficient.
 */
export type ExistArgs<TModel extends Model<any>> = {
  where?: WhereInput<TModel>;
};

/**
 * Enhanced exist args with logical operators
 */
export type EnhancedExistArgs<TModel extends Model<any>> = ExistArgs<TModel> & {
  AND?: WhereInput<TModel>[];
  OR?: WhereInput<TModel>[];
  NOT?: WhereInput<TModel> | WhereInput<TModel>[];
};
