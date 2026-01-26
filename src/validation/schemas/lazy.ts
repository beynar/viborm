import v, { parse } from "..";
import type { VibSchema } from "../types";

/**
 * Creates a lazy schema that defers evaluation until first access.
 * The schema is cached after first resolution.
 *
 * The returned schema is typed as T, so it's transparent to consumers -
 * InferInput and InferOutput work as if it were the wrapped schema.
 *
 * @param factory - A function that returns the schema to wrap
 * @returns A schema typed as T that lazily resolves on first access
 */
export function lazy<T extends VibSchema>(factory: () => T): T {
  let cached: T | undefined;

  const resolve = () => (cached ??= factory());

  const lazySchema = {
    get "~standard"() {
      return resolve()["~standard"];
    },
    get " vibInferred"() {
      return resolve()[" vibInferred"];
    },
  };

  return lazySchema as T;
}
