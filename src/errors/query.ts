import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Connection-related errors
 */
export class ConnectionError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.CONNECTION_FAILED, opts);
    this.name = "ConnectionError";
  }
}

/**
 * Query execution errors
 */
export class QueryError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.QUERY_FAILED, opts);
    this.name = "QueryError";
  }
}

/**
 * Record not found (for OrThrow operations)
 */
export class NotFoundError extends VibORMError {
  constructor(
    model: string,
    operation: string,
    options?: { meta?: VibORMErrorMeta }
  ) {
    super(
      `No ${model} record found for ${operation}`,
      VibORMErrorCode.RECORD_NOT_FOUND,
      {
        meta: { ...options?.meta, model, operation },
      }
    );
    this.name = "NotFoundError";
  }
}

/**
 * Nested write operation errors
 */
export class NestedWriteError extends VibORMError {
  constructor(
    message: string,
    relation: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {
      meta: { ...options?.meta, relation },
    };
    if (options?.cause) opts.cause = options.cause;
    super(message, options?.code ?? VibORMErrorCode.NESTED_WRITE_FAILED, opts);
    this.name = "NestedWriteError";

    // Preserve the original stack trace if available
    if (options?.cause?.stack) {
      this.stack = `${this.stack}\nCaused by: ${options.cause.stack}`;
    }
  }
}

/**
 * Batch-plan nested-write assertion failures
 *
 * Atomic batch plans encode preconditions (connect/disconnect targets must
 * exist, correlation checks) as SQL statements that error on purpose when the
 * precondition fails (adapter.assertions). Each dialect surfaces a different
 * raw error (PG: division by zero, MySQL/SQLite: invalid JSON); the driver
 * error mapping normalizes all of them to this type.
 */
export class NestedWriteAssertionError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED, opts);
    this.name = "NestedWriteAssertionError";
  }
}

/**
 * Feature not supported errors
 */
export class FeatureNotSupportedError extends VibORMError {
  constructor(feature: string, method: string, suggestion?: string) {
    const message = suggestion
      ? `${feature}.${method} is not supported. ${suggestion}`
      : `${feature}.${method} is not supported by this driver.`;
    super(message, VibORMErrorCode.FEATURE_NOT_SUPPORTED, {
      meta: { feature, method },
    });
    this.name = "FeatureNotSupportedError";
  }
}

/**
 * Pending operation execution errors
 *
 * Thrown when attempting to execute a PendingOperation in an invalid way,
 * such as awaiting after executeWith() or calling executeWith() after await.
 */
export class PendingOperationError extends VibORMError {
  constructor(
    message: string,
    code:
      | VibORMErrorCode.OPERATION_ALREADY_EXECUTED
      | VibORMErrorCode.OPERATION_EXECUTION_CONFLICT
      | VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
    options?: { meta?: VibORMErrorMeta }
  ) {
    super(message, code, { meta: options?.meta });
    this.name = "PendingOperationError";
  }

  /**
   * Create error for attempting to await after executeWith()
   */
  static alreadyExecutedWithDriver(
    model: string,
    operation: string
  ): PendingOperationError {
    return new PendingOperationError(
      "Cannot await a PendingOperation that was already executed with executeWith(). " +
        `The ${model}.${operation}() operation was already executed in a transaction context. ` +
        "Create a new operation if you need to execute outside the transaction.",
      VibORMErrorCode.OPERATION_ALREADY_EXECUTED,
      { meta: { model, operation } }
    );
  }

  /**
   * Create error for attempting executeWith() after await
   */
  static alreadyExecutedDefault(
    model: string,
    operation: string
  ): PendingOperationError {
    return new PendingOperationError(
      "Cannot call executeWith() on a PendingOperation that was already awaited. " +
        `The ${model}.${operation}() operation was already executed outside a transaction. ` +
        "Create a new operation for transaction execution.",
      VibORMErrorCode.OPERATION_EXECUTION_CONFLICT,
      { meta: { model, operation } }
    );
  }

  /**
   * Create error for attempting executeWith() with a different driver
   */
  static differentDriverConflict(
    model: string,
    operation: string
  ): PendingOperationError {
    return new PendingOperationError(
      "Cannot call executeWith() with a different driver. " +
        `The ${model}.${operation}() operation was already executed in another transaction context.`,
      VibORMErrorCode.OPERATION_EXECUTION_CONFLICT,
      { meta: { model, operation } }
    );
  }

  /**
   * Create error for operations from different clients in $transaction
   */
  static clientMismatch(
    model: string,
    operation: string
  ): PendingOperationError {
    return new PendingOperationError(
      `Cannot execute ${model}.${operation}() in this transaction: ` +
        "the operation was created by a different client instance. " +
        "All operations in $transaction([...]) must come from the same client.",
      VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
      { meta: { model, operation } }
    );
  }
}

/**
 * Type guard for pending operation errors
 */
export function isPendingOperationError(
  error: unknown
): error is PendingOperationError {
  return error instanceof PendingOperationError;
}

/**
 * Internal query engine error
 */
export class QueryEngineError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.INTERNAL_ERROR, opts);
    this.name = "QueryEngineError";
  }
}

/**
 * Type guard for not found errors
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/**
 * Unsupported vector operations
 *
 * Use this to override adapter.vector when pgvector is not available.
 */
export const unsupportedVector = {
  literal: (): never => {
    throw new FeatureNotSupportedError(
      "vector",
      "literal",
      "Load the pgvector extension."
    );
  },
  l2: (): never => {
    throw new FeatureNotSupportedError(
      "vector",
      "l2",
      "Load the pgvector extension."
    );
  },
  cosine: (): never => {
    throw new FeatureNotSupportedError(
      "vector",
      "cosine",
      "Load the pgvector extension."
    );
  },
};

/**
 * Unsupported geospatial operations
 *
 * Use this to override adapter.geospatial when PostGIS is not available.
 */
export const unsupportedGeospatial = {
  point: (): never => {
    throw new FeatureNotSupportedError("geospatial", "point");
  },
  equals: (): never => {
    throw new FeatureNotSupportedError("geospatial", "equals");
  },
  intersects: (): never => {
    throw new FeatureNotSupportedError("geospatial", "intersects");
  },
  contains: (): never => {
    throw new FeatureNotSupportedError("geospatial", "contains");
  },
  within: (): never => {
    throw new FeatureNotSupportedError("geospatial", "within");
  },
  crosses: (): never => {
    throw new FeatureNotSupportedError("geospatial", "crosses");
  },
  overlaps: (): never => {
    throw new FeatureNotSupportedError("geospatial", "overlaps");
  },
  touches: (): never => {
    throw new FeatureNotSupportedError("geospatial", "touches");
  },
  covers: (): never => {
    throw new FeatureNotSupportedError("geospatial", "covers");
  },
  dWithin: (): never => {
    throw new FeatureNotSupportedError("geospatial", "dWithin");
  },
};
