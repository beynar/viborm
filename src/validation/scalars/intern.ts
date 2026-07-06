import type { ScalarState } from "@schema/scalars/common";

/**
 * Interning for scalar filter/update schemas.
 *
 * A scalar's filter/update validation schema is a pure function of its base
 * schema, which — when the user has NOT attached a custom standard schema —
 * is fully determined by a handful of flags (nullable, array, withTimezone).
 * Two `s.string()` fields on different models therefore build structurally
 * identical filter trees; interning shares one instance across all of them.
 *
 * Shared instances are safe: filter schemas are immutable after construction,
 * contain no field/model identity (error paths are attached by the parent
 * object validator), and their only lazy mutations (object resolve() flag,
 * jsonSchema getter swap) are idempotent set-once operations.
 *
 * Fields with a custom standard schema (`state.schema !== undefined`) return
 * a null key and always build fresh — unknown validators are never interned.
 */
export const scalarInternKey = (state: ScalarState): string | null => {
  if (state.schema !== undefined) {
    return null;
  }
  return `${state.nullable ? 1 : 0}${state.array ? 1 : 0}${
    state.withTimezone ? 1 : 0
  }`;
};

/**
 * Create a per-kind intern cache. Each scalar module owns its own instances
 * (one for filter, one for update), so the key space is just the flag bits.
 */
export const createScalarInterner = <T>(): ((
  key: string | null,
  build: () => T
) => T) => {
  const cache = new Map<string, T>();
  return (key, build) => {
    if (key === null) {
      return build();
    }
    let value = cache.get(key);
    if (value === undefined) {
      value = build();
      cache.set(key, value);
    }
    return value;
  };
};
