/**
 * SQL-only aliases that cannot collide with validated model identifiers.
 * A leading digit survives every supported provider while schema identifiers
 * must start with a letter or underscore.
 */
export const VECTOR_DISTANCE_RESULT_KEY = "0viborm_vector_distance" as const;
export const RELATION_COUNTS_RESULT_KEY = "0viborm_relation_counts" as const;
export const EMPTY_ROW_RESULT_KEY = "0viborm_empty_row" as const;

export type AggregateResultName = "_count" | "_avg" | "_sum" | "_min" | "_max";

export function getAggregateResultKey(name: AggregateResultName): string {
  return `0viborm_aggregate:${name.slice(1)}`;
}

export function getAggregateResultName(
  key: string
): AggregateResultName | undefined {
  switch (key) {
    case "0viborm_aggregate:count":
      return "_count";
    case "0viborm_aggregate:avg":
      return "_avg";
    case "0viborm_aggregate:sum":
      return "_sum";
    case "0viborm_aggregate:min":
      return "_min";
    case "0viborm_aggregate:max":
      return "_max";
    default:
      return undefined;
  }
}
