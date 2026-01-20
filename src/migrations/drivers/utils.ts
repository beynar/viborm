/**
 * Migration Driver Utilities
 *
 * Shared helper functions used across multiple migration drivers.
 */

/**
 * Groups items by a key function.
 *
 * @param items - Array of items to group
 * @param keyFn - Function to extract the grouping key
 * @returns Map from key to array of items
 */
export function groupBy<T>(
  items: T[],
  keyFn: (item: T) => string
): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFn(item);
    const existing = map.get(key);
    if (existing) {
      existing.push(item);
    } else {
      map.set(key, [item]);
    }
  }
  return map;
}

/**
 * Groups items by two levels of keys (nested grouping).
 *
 * @param items - Array of items to group
 * @param primaryKeyFn - Function to extract the primary grouping key
 * @param secondaryKeyFn - Function to extract the secondary grouping key
 * @returns Nested Map structure
 */
export function groupByNested<T>(
  items: T[],
  primaryKeyFn: (item: T) => string,
  secondaryKeyFn: (item: T) => string
): Map<string, Map<string, T[]>> {
  const map = new Map<string, Map<string, T[]>>();
  for (const item of items) {
    const pk = primaryKeyFn(item);
    const sk = secondaryKeyFn(item);

    let secondary = map.get(pk);
    if (!secondary) {
      secondary = new Map();
      map.set(pk, secondary);
    }

    const existing = secondary.get(sk);
    if (existing) {
      existing.push(item);
    } else {
      secondary.set(sk, [item]);
    }
  }
  return map;
}
