import type { VibSchema } from "../types";

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
  let cached: T | undefined;

  const resolve = (): T => (cached ??= factory());

  // Use a Proxy to transparently forward all operations to the resolved schema
  const proxy = new Proxy({} as T, {
    get(_target, prop, receiver) {
      const resolved = resolve();
      const value = Reflect.get(resolved, prop, receiver);
      // Bind methods to the resolved schema to preserve `this` context
      return typeof value === "function" ? value.bind(resolved) : value;
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
