import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Invalid TTL format or value
 */
export class CacheInvalidTTLError extends VibORMError {
  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_INVALID_TTL, {
      meta: options?.meta,
    });
    this.name = "CacheInvalidTTLError";
  }
}

/**
 * Invalid cache key (circular reference, uncacheable type)
 */
export class CacheInvalidKeyError extends VibORMError {
  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_INVALID_KEY, {
      meta: options?.meta,
    });
    this.name = "CacheInvalidKeyError";
  }
}

/**
 * Operation cannot be cached (e.g., mutation operations)
 */
export class CacheOperationNotCacheableError extends VibORMError {
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
    this.name = "CacheOperationNotCacheableError";
  }
}

/**
 * Invalid or missing cache configuration (options or driver)
 */
export class CacheConfigurationError extends VibORMError {
  constructor(message: string, options?: { meta?: VibORMErrorMeta }) {
    super(message, VibORMErrorCode.CACHE_CONFIGURATION, {
      meta: options?.meta,
    });
    this.name = "CacheConfigurationError";
  }
}
