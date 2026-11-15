import { CacheConfigurationError } from "../errors/cache";
import type { Codec } from "../index";

/** One codec step, its failure the cache's: named, exposing no value. */
function step<T>(
  method: "snapshot" | "materialize",
  operation: string,
  message: string,
  run: () => T
): T {
  try {
    return run();
  } catch (cause) {
    throw new CacheConfigurationError(message, {
      cause: cause instanceof Error ? cause : undefined,
      meta: { method, operation },
    });
  }
}

/**
 * A call's codec whose failures are the cache's: a value the codec cannot
 * represent, and a stored entry that does not follow the shape, are each a
 * `CacheConfigurationError` that names the step and exposes no value.
 */
export function cacheCodec<R>(codec: Codec<R>, operation: string): Codec<R> {
  return {
    run: () => codec.run(),
    snapshot: () =>
      step(
        "snapshot",
        operation,
        "The operation result cannot be represented by the cache result codec.",
        () => codec.snapshot()
      ),
    materialize: (snapshot) =>
      step(
        "materialize",
        operation,
        "The cached result snapshot is malformed.",
        () => codec.materialize(snapshot)
      ),
  };
}
