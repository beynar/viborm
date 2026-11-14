import {
  coded,
  VibORMError,
  VibORMErrorCode,
  type VibORMErrorMeta,
} from "./base";

/**
 * Invalid TTL format or value
 */
export class CacheInvalidTTLError extends coded<
  typeof VibORMErrorCode.CACHE_INVALID_TTL,
  { meta?: VibORMErrorMeta }
>("CacheInvalidTTLError", VibORMErrorCode.CACHE_INVALID_TTL) {}

/**
 * Invalid cache key (circular reference, uncacheable type)
 */
export class CacheInvalidKeyError extends coded<
  typeof VibORMErrorCode.CACHE_INVALID_KEY,
  { meta?: VibORMErrorMeta }
>("CacheInvalidKeyError", VibORMErrorCode.CACHE_INVALID_KEY) {}

/**
 * Operation cannot be cached (e.g., mutation operations)
 */
export class CacheOperationNotCacheableError extends VibORMError {
  static override readonly diagnosticName = "CacheOperationNotCacheableError";

  /** Literal discriminant: this class always carries `CACHE_OPERATION_NOT_CACHEABLE`. */
  declare readonly code: typeof VibORMErrorCode.CACHE_OPERATION_NOT_CACHEABLE;

  constructor(
    operation: string,
    cacheableOperations: string[],
    options?: { meta?: VibORMErrorMeta }
  ) {
    super(
      `Operation "${operation}" is not cacheable. Only read operations can be cached: ${cacheableOperations.join(", ")}`,
      VibORMErrorCode.CACHE_OPERATION_NOT_CACHEABLE,
      {
        meta: { ...options?.meta, operation },
      }
    );
  }
}

/**
 * Invalid or missing cache configuration (options or driver)
 */
export class CacheConfigurationError extends coded<
  typeof VibORMErrorCode.CACHE_CONFIGURATION,
  { cause?: Error | undefined; meta?: VibORMErrorMeta }
>("CacheConfigurationError", VibORMErrorCode.CACHE_CONFIGURATION) {}
