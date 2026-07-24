/**
 * Lazy record helper for deferred schema construction.
 *
 * Builds a plain object whose properties are memoizing getters: each value is
 * constructed on first read and cached (stable identity) thereafter. Getters
 * are enumerable + configurable, so the object is indistinguishable from an
 * eagerly-built record to consumers (`key in obj`, `Object.keys`, single-key
 * access all behave identically) — the only difference is that a builder that
 * is never read never runs.
 *
 * Used to make model schema construction pay-per-use: a `findUnique` request
 * only builds the whereUnique/select/include schemas it touches, never the
 * create/update/aggregate trees — a large saving on the cold (first-query)
 * path per serverless isolate.
 */
export function lazyRecord<T extends object>(
  builders: {
    [K in keyof T]: () => T[K];
  }
): T {
  const target = {} as T;
  for (const key of Object.keys(builders) as (keyof T)[]) {
    let built = false;
    let value: T[keyof T];
    Object.defineProperty(target, key, {
      enumerable: true,
      configurable: true,
      get() {
        if (!built) {
          value = builders[key]();
          built = true;
        }
        return value;
      },
    });
  }
  return target;
}
