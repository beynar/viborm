/**
 * SQL-only aliases that cannot collide with validated model identifiers.
 * A leading digit survives every supported provider while schema identifiers
 * must start with a letter or underscore.
 */
export const DISTANCE_RESULT_KEY = "0viborm_distance" as const;
export const RELATION_COUNTS_RESULT_KEY = "0viborm_relation_counts" as const;
export const EMPTY_ROW_RESULT_KEY = "0viborm_empty_row" as const;
/**
 * The cursor predicate's derived-table carrier, one per requested sort key.
 *
 * A nullable sort column's cursor predicate reads the cursor row's own values
 * out of a derived table, and those values need names that cannot collide with
 * a model identifier — which is this file's whole subject. It lives here, and
 * not as a literal in the engine, so a witness can assert the carrier without
 * pinning a spelling the engine is free to choose (Arnaud's D-21).
 */
export const CURSOR_CARRIER_PREFIX = "0viborm_cursor_" as const;
/** Private envelope tag for one direct polymorphic result carrier. */
export const POLYMORPHIC_RESULT_STATE_KEY = "__viborm_state" as const;
export const POLYMORPHIC_RESULT_STATE_LINKED = "linked" as const;
export const POLYMORPHIC_RESULT_STATE_INVALID = "invalid" as const;
/** The direct polymorphic COLLECTION carrier: one document per relation column. */
export const POLYMORPHIC_RESULT_STATE_COLLECTION = "collection" as const;
/**
 * The collection carrier's PRIVATE arm container.
 *
 * Arms live one level down, under this key, precisely so a user variant named
 * `only`, `variants` or `__viborm_state` cannot collide with a carrier key —
 * the same hostility the public grammar owes.
 */
export const POLYMORPHIC_COLLECTION_ARMS_KEY = "arms" as const;
export const POLYMORPHIC_COLLECTION_MEMBERSHIP_KEY = "membership" as const;
/**
 * The variant slot's INTEGRITY carrier: one count per configured member of the
 * memberships whose target row is gone (Arnaud's D-26).
 *
 * It rides the slot's own document beside the arms, so it takes this file's
 * leading-digit spelling rather than a bare word: the deleted engine could
 * afford `orphans` because it nested every arm one level down under
 * `arms`, and this engine keeps the arms at the document's top level, where a
 * bare carrier name would be reachable by a variant of the same name. A
 * validated identifier cannot start with a digit, so this one cannot collide.
 */
export const POLYMORPHIC_COLLECTION_ORPHANS_KEY = "0viborm_orphans" as const;
export const POLYMORPHIC_COLLECTION_ROWS_KEY = "rows" as const;

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
