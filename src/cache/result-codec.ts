import { CacheConfigurationError } from "../errors/cache";
import type { Codec } from "../index";

/**
 * A call's codec whose failures are the cache's: a value the codec cannot
 * represent, and a stored entry that does not follow the shape, are each a
 * `CacheConfigurationError` that names the step and exposes no value.
 */
export function cacheCodec<R>(codec: Codec<R>, operation: string): Codec<R> {
  return {
    run: () => codec.run(),
    snapshot(): unknown {
      try {
        return codec.snapshot();
      } catch (cause) {
        throw new CacheConfigurationError(
          "The operation result cannot be represented by the cache result codec.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "snapshot", operation },
          }
        );
      }
    },
    materialize(snapshot: unknown): R {
      try {
        return codec.materialize(snapshot);
      } catch (cause) {
        throw new CacheConfigurationError(
          "The cached result snapshot is malformed.",
          {
            cause: cause instanceof Error ? cause : undefined,
            meta: { method: "materialize", operation },
          }
        );
      }
    },
  };
}
