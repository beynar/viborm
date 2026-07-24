import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Invalid TTL format or value
 */
export class CacheInvalidTTLError extends VibORMError {
  static override readonly diagnosticName = "CacheInvalidTTLError";

  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_INVALID_TTL, {
      meta: options?.meta,
    });
  }
}

/**
 * Invalid cache key (circular reference, uncacheable type)
 */
export class CacheInvalidKeyError extends VibORMError {
  static override readonly diagnosticName = "CacheInvalidKeyError";

  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_INVALID_KEY, {
      meta: options?.meta,
    });
  }
}

/**
 * Operation cannot be cached (e.g., mutation operations)
 */
export class CacheOperationNotCacheableError extends VibORMError {
  static override readonly diagnosticName = "CacheOperationNotCacheableError";

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
export class CacheConfigurationError extends VibORMError {
  static override readonly diagnosticName = "CacheConfigurationError";

  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_CONFIGURATION, {
      meta: options?.meta,
    });
  }
}
