// Dependency-free so the browser decoder can share it.
export interface NormalizedRecurrence {
  readonly depth: number | false;
  readonly cycles: "reject" | "prevent" | "allow";
  /** A projection's own output budget, when its caller set one. */
  readonly maxOccurrences?: number;
}

/**
 * How many occurrences one recursive projection decodes under one outer row
 * unless its `recurse.maxOccurrences` says otherwise. An occurrence is one
 * output row: a node reached by several paths is counted once per path, which
 * is why a graph can outgrow it with few stored rows.
 */
export const DEFAULT_MAX_OCCURRENCES = 10_000;

/**
 * Whether an occurrence at `level` carries the repeated key — the outer slot's
 * own occurrences are level 1. It does at every level of an exhaustive
 * traversal and at every level before a numeric cutoff; at the cutoff the key
 * is absent. The decoder and the cache walker both read this one rule.
 */
export function carriesRepeatedKey(
  depth: number | false,
  level: number
): boolean {
  return depth === false || level < depth;
}
