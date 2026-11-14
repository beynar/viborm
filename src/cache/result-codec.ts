import { CacheConfigurationError } from "@errors";
import { type Codec, codecOf } from "@extensions/codec";
import type { PreparedOperation } from "@query-engine/raptor3/commands";

/** Each codec as the cache speaks it, made once. */
const translated = new WeakMap<Codec, Codec>();

/**
 * A call's codec whose failures are the cache's: a value the codec cannot
 * represent, and a stored entry that does not follow the shape, are each a
 * `CacheConfigurationError` that names the step and exposes no value.
 */
export function cacheCodec(codec: Codec, operation: string): Codec {
  const known = translated.get(codec);
  if (known !== undefined) return known;
  const made: Codec = Object.freeze({
    snapshot(input: unknown): unknown {
      try {
        return codec.snapshot(input);
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
    materialize(snapshot: unknown): unknown {
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
  });
  translated.set(codec, made);
  return made;
}

/** The cache's codec of one prepared operation. */
export function routedCodec(routed: PreparedOperation): Codec {
  return cacheCodec(codecOf(routed), routed.requested.operation);
}
