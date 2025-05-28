import type { Model } from "../../../schema/model.js";
import type { BaseField } from "../../../schema/fields/base.js";
import type {
  FieldNames,
  ModelFields,
  MapFieldType,
} from "../foundation/index.js";

// ===== BASIC AGGREGATION TYPES =====

/**
 * Count aggregation result
 */
export type CountAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? number
    : never;
} & {
  _all?: number;
};

/**
 * Average aggregation result (only for numeric fields)
 */
export type AvgAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? number | null
        : never
      : never
    : never;
};

/**
 * Sum aggregation result (only for numeric fields)
 */
export type SumAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? number | null
        : never
      : never
    : never;
};

/**
 * Min aggregation result
 */
export type MinAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> | null
      : never
    : never;
};

/**
 * Max aggregation result
 */
export type MaxAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> | null
      : never
    : never;
};

// ===== COMPOSITE AGGREGATION TYPES =====

/**
 * Full aggregation result containing all possible aggregations
 */
export type FullAggregateResult<TModel extends Model<any>> = {
  _count: CountAggregateResult<TModel>;
  _avg: AvgAggregateResult<TModel>;
  _sum: SumAggregateResult<TModel>;
  _min: MinAggregateResult<TModel>;
  _max: MaxAggregateResult<TModel>;
};

/**
 * Conditional aggregation result based on selected operations
 */
export type ConditionalAggregateResult<
  TModel extends Model<any>,
  TSelect extends Record<string, any>
> = {
  [K in keyof TSelect]: K extends "_count"
    ? TSelect[K] extends Record<string, any>
      ? {
          [F in keyof TSelect[K]]: F extends FieldNames<TModel> | "_all"
            ? number
            : never;
        }
      : CountAggregateResult<TModel>
    : K extends "_avg"
    ? TSelect[K] extends Record<string, any>
      ? {
          [F in keyof TSelect[K]]: F extends FieldNames<TModel>
            ? F extends keyof ModelFields<TModel>
              ? ModelFields<TModel>[F] extends BaseField<any>
                ? MapFieldType<ModelFields<TModel>[F]> extends number
                  ? number | null
                  : never
                : never
              : never
            : never;
        }
      : AvgAggregateResult<TModel>
    : K extends "_sum"
    ? TSelect[K] extends Record<string, any>
      ? {
          [F in keyof TSelect[K]]: F extends FieldNames<TModel>
            ? F extends keyof ModelFields<TModel>
              ? ModelFields<TModel>[F] extends BaseField<any>
                ? MapFieldType<ModelFields<TModel>[F]> extends number
                  ? number | null
                  : never
                : never
              : never
            : never;
        }
      : SumAggregateResult<TModel>
    : K extends "_min"
    ? TSelect[K] extends Record<string, any>
      ? {
          [F in keyof TSelect[K]]: F extends FieldNames<TModel>
            ? F extends keyof ModelFields<TModel>
              ? ModelFields<TModel>[F] extends BaseField<any>
                ? MapFieldType<ModelFields<TModel>[F]> | null
                : never
              : never
            : never;
        }
      : MinAggregateResult<TModel>
    : K extends "_max"
    ? TSelect[K] extends Record<string, any>
      ? {
          [F in keyof TSelect[K]]: F extends FieldNames<TModel>
            ? F extends keyof ModelFields<TModel>
              ? ModelFields<TModel>[F] extends BaseField<any>
                ? MapFieldType<ModelFields<TModel>[F]> | null
                : never
              : never
            : never;
        }
      : MaxAggregateResult<TModel>
    : never;
};

// ===== GROUP BY AGGREGATION TYPES =====

/**
 * Group by result with aggregations
 */
export type GroupByAggregateResult<
  TModel extends Model<any>,
  TGroupBy extends FieldNames<TModel>[],
  TAggregates extends Record<string, any>
> = Array<
  {
    [K in TGroupBy[number]]: K extends keyof ModelFields<TModel>
      ? ModelFields<TModel>[K] extends BaseField<any>
        ? MapFieldType<ModelFields<TModel>[K]>
        : never
      : never;
  } & ConditionalAggregateResult<TModel, TAggregates>
>;

/**
 * Having clause result for group by operations
 */
export type HavingAggregateResult<
  TModel extends Model<any>,
  THaving extends Record<string, any>
> = {
  [K in keyof THaving]: K extends "_count" | "_avg" | "_sum" | "_min" | "_max"
    ? boolean
    : never;
};

// ===== ADVANCED AGGREGATION TYPES =====

/**
 * Statistical aggregation result
 */
export type StatisticalAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? {
            count: number;
            sum: number | null;
            avg: number | null;
            min: number | null;
            max: number | null;
            variance: number | null;
            stddev: number | null;
            median: number | null;
            mode: number | null;
          }
        : {
            count: number;
            min: MapFieldType<ModelFields<TModel>[K]> | null;
            max: MapFieldType<ModelFields<TModel>[K]> | null;
            mode: MapFieldType<ModelFields<TModel>[K]> | null;
          }
      : never
    : never;
};

/**
 * Percentile aggregation result
 */
export type PercentileAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? {
            p25: number | null;
            p50: number | null; // median
            p75: number | null;
            p90: number | null;
            p95: number | null;
            p99: number | null;
          }
        : never
      : never
    : never;
};

/**
 * Time-based aggregation result
 */
export type TimeAggregateResult<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]?: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends Date
        ? {
            earliest: Date | null;
            latest: Date | null;
            range: number | null; // milliseconds
            count: number;
          }
        : never
      : never
    : never;
};

// ===== UTILITY AGGREGATION TYPES =====

/**
 * Check if field supports numeric aggregations
 */
export type SupportsNumericAggregation<
  TModel extends Model<any>,
  TField extends FieldNames<TModel>
> = TField extends keyof ModelFields<TModel>
  ? ModelFields<TModel>[TField] extends BaseField<any>
    ? MapFieldType<ModelFields<TModel>[TField]> extends number
      ? true
      : false
    : false
  : false;

/**
 * Check if field supports date aggregations
 */
export type SupportsDateAggregation<
  TModel extends Model<any>,
  TField extends FieldNames<TModel>
> = TField extends keyof ModelFields<TModel>
  ? ModelFields<TModel>[TField] extends BaseField<any>
    ? MapFieldType<ModelFields<TModel>[TField]> extends Date
      ? true
      : false
    : false
  : false;

/**
 * Extract numeric fields from model
 */
export type NumericFields<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends number
        ? K
        : never
      : never
    : never;
}[FieldNames<TModel>];

/**
 * Extract date fields from model
 */
export type DateFields<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends Date
        ? K
        : never
      : never
    : never;
}[FieldNames<TModel>];

/**
 * Extract string fields from model
 */
export type StringFields<TModel extends Model<any>> = {
  [K in FieldNames<TModel>]: K extends keyof ModelFields<TModel>
    ? ModelFields<TModel>[K] extends BaseField<any>
      ? MapFieldType<ModelFields<TModel>[K]> extends string
        ? K
        : never
      : never
    : never;
}[FieldNames<TModel>];

/**
 * Union of all aggregation operation types
 */
export type AggregationOperation = "_count" | "_avg" | "_sum" | "_min" | "_max";

/**
 * Aggregation operation validation
 */
export type ValidateAggregationOperation<
  TModel extends Model<any>,
  TField extends FieldNames<TModel>,
  TOperation extends AggregationOperation
> = TOperation extends "_count"
  ? true
  : TOperation extends "_avg" | "_sum"
  ? SupportsNumericAggregation<TModel, TField>
  : TOperation extends "_min" | "_max"
  ? true
  : false;
