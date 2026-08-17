import type { VibSchema } from "../types";
import { isFunction } from "../value-guards";

/**
 * Creates a lazy schema that defers evaluation until first access.
 * The schema is cached after first resolution.
 *
 * Uses a Proxy to transparently forward all property access, method calls,
 * and operations to the wrapped schema. This ensures the lazy schema
 * behaves identically to the wrapped type.
 *
 * The returned schema is typed as T, so it's transparent to consumers -
 * InferInput and InferOutput work as if it were the wrapped schema.
 *
 * @param factory - A function that returns the schema to wrap
 * @returns A schema typed as T that lazily resolves on first access
 */
export function lazy<T extends VibSchema>(factory: () => T): T {
  let build: (() => T) | undefined = factory;
  let value: T;

  const resolve = (): T => {
    if (build) {
      value = build();
      build = undefined;
    }
    return value;
  };

  // Use a Proxy to transparently forward all operations to the resolved schema
  const proxy = new Proxy({} as T, {
    get(_target, prop, receiver) {
      const resolved = resolve();
      const value = Reflect.get(resolved, prop, receiver);
      // Bind methods to the resolved schema to preserve `this` context
      return isFunction(value) ? value.bind(resolved) : value;
    },

    has(_target, prop) {
      return Reflect.has(resolve(), prop);
    },

    ownKeys(_target) {
      return Reflect.ownKeys(resolve());
    },

    getOwnPropertyDescriptor(_target, prop) {
      return Reflect.getOwnPropertyDescriptor(resolve(), prop);
    },

    getPrototypeOf(_target) {
      return Reflect.getPrototypeOf(resolve());
    },
  });

  return proxy;
}

/**
 * Lightweight deferred schema reference.
 *
 * Unlike `lazy()` (a Proxy that resolves on ANY property access — including
 * the object validator's duck-typing reads), `lazyRef` exposes a static
 * `type` and a `~standard.validate` that only builds the wrapped schema when
 * the validator is first CALLED. Used for args→core schema cross-references
 * so an operation only constructs the core schemas its arguments actually
 * use (e.g. `findUnique({ where })` never builds select/include).
 *
 * NOT a general-purpose wrapper: it reports no `acceptsUndefined`/default
 * metadata, so it must only wrap schemas with no default value (true for all
 * core schema references).
 */
export function lazyRef<T extends VibSchema>(factory: () => T): T {
  let build: (() => T) | undefined = factory;
  let value: T;
  const resolve = (): T => {
    if (build) {
      value = build();
      build = undefined;
    }
    return value;
  };

  return {
    type: "lazyRef",
    /**
     * JSON-schema conversion unwraps through this (resolves on demand) — see
     * the `lazyRef` case in {@link file://../json-schema/converters.ts}. A
     * reference that points BACK at a schema still being converted (a scalar
     * filter's `not`) is closed there with a `$ref`, so unwrapping terminates.
     */
    get wrapped() {
      return resolve();
    },
    // Introspection surface (resolves on demand). Deliberately NOT exposed:
    // `options`/`acceptsUndefined`/`default` — the object validator
    // duck-types those during resolve(), and resolving getters there would
    // rebuild the wrapped schema eagerly, defeating the laziness.
    get entries() {
      return (resolve() as { entries?: unknown }).entries;
    },
    "~standard": {
      version: 1,
      vendor: "viborm",
      validate: (value: unknown) => resolve()["~standard"].validate(value),
      get jsonSchema() {
        return resolve()["~standard"].jsonSchema;
      },
    },
  } as unknown as T;
}
