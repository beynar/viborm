import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Connection-related errors
 */
export class ConnectionError extends VibORMError {
  static override readonly diagnosticName = "ConnectionError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: {
      cause?: Error;
      diagnostics?: DiagnosticDisclosure;
      meta?: VibORMErrorMeta;
    } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.diagnostics) opts.diagnostics = options.diagnostics;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.CONNECTION_FAILED, opts);
  }
}

/**
 * Client construction failures (Prisma P1012)
 *
 * Raised while a client is being built or while its schema-shaped surface is being resolved:
 * a missing driver, a schema that fails name hydration, or an access to a model the schema
 * does not define. These are configuration faults, not query faults — nothing has reached the
 * database yet.
 *
 * Prisma raises `PrismaClientInitializationError` for the same category and exposes its code
 * on `errorCode`; P1012 is Prisma's "Schema validation error", the closest documented code for
 * a client that cannot be constructed from the given schema and configuration. VibORM
 * publishes it through the shared `prismaCode` getter.
 */
export class ClientInitializationError extends VibORMError {
  static override readonly diagnosticName = "ClientInitializationError";

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
    super(message, VibORMErrorCode.CLIENT_INITIALIZATION, opts);
  }
}

/**
 * Type guard for client initialization errors
 */
export function isClientInitializationError(
  error: unknown
): error is ClientInitializationError {
  return error instanceof ClientInitializationError;
}

/**
 * Query execution errors
 */
export class QueryError extends VibORMError {
  static override readonly diagnosticName = "QueryError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: {
      cause?: Error;
      diagnostics?: DiagnosticDisclosure;
      meta?: VibORMErrorMeta;
    } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.diagnostics) opts.diagnostics = options.diagnostics;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.QUERY_FAILED, opts);
  }
}

/**
 * Record not found (for OrThrow operations)
 */
export class NotFoundError extends VibORMError {
  static override readonly diagnosticName = "NotFoundError";

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
  }
}

/**
 * Nested write operation errors
 */
export class NestedWriteError extends VibORMError {
  static override readonly diagnosticName = "NestedWriteError";

  constructor(
    message: string,
    relation: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: {
      cause?: Error;
      diagnostics?: DiagnosticDisclosure;
      meta?: VibORMErrorMeta;
    } = {
      meta: { ...options?.meta, relation },
    };
    if (options?.cause) opts.cause = options.cause;
    if (options?.diagnostics) opts.diagnostics = options.diagnostics;
    super(message, options?.code ?? VibORMErrorCode.NESTED_WRITE_FAILED, opts);
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
  static override readonly diagnosticName = "NestedWriteAssertionError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    const opts: {
      cause?: Error;
      diagnostics?: DiagnosticDisclosure;
      meta?: VibORMErrorMeta;
    } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.diagnostics) opts.diagnostics = options.diagnostics;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED, opts);
  }
}

/**
 * Feature not supported errors
 */
export class FeatureNotSupportedError extends VibORMError {
  static override readonly diagnosticName = "FeatureNotSupportedError";

  constructor(feature: string, method: string, suggestion?: string) {
    const message = suggestion
      ? `${feature}.${method} is not supported. ${suggestion}`
      : `${feature}.${method} is not supported by this driver.`;
    super(message, VibORMErrorCode.FEATURE_NOT_SUPPORTED, {
      meta: { feature, method },
    });
  }
}

/**
 * Pending operation execution errors
 *
 * Thrown when attempting to execute a PendingOperation in an invalid way,
 * such as awaiting after executeWith() or calling executeWith() after await.
 */
export class PendingOperationError extends VibORMError {
  static override readonly diagnosticName = "PendingOperationError";

  constructor(
    message: string,
    code:
      | VibORMErrorCode.OPERATION_ALREADY_EXECUTED
      | VibORMErrorCode.OPERATION_EXECUTION_CONFLICT
      | VibORMErrorCode.OPERATION_CLIENT_MISMATCH
      | VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
    options?: { meta?: VibORMErrorMeta }
  ) {
    super(message, code, { meta: options?.meta });
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

  /** Create error for mixing root and transaction-bound operation scopes. */
  static scopeMismatch(
    model: string,
    operation: string
  ): PendingOperationError {
    return new PendingOperationError(
      `Cannot execute ${model}.${operation}() in this transaction: ` +
        "the operation was created outside this transaction scope. " +
        "Create the operation from the client provided to this transaction callback.",
      VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
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
  // Annotated `string` (not the literal) so a subclass may narrow it — the
  // pattern VibORMError itself uses for its subclasses.
  static override readonly diagnosticName: string = "QueryEngineError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      /** Subclass seam: a distinct taxonomy code (default INTERNAL_ERROR). */
      code?: VibORMErrorCode | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, options?.code ?? VibORMErrorCode.INTERNAL_ERROR, opts);
  }
}

/**
 * A payload SHAPE the query engine deliberately does not express — a documented
 * capability boundary (a compound key or non-literal fold past a proven surface,
 * an inexpressible sub-shape, a parity refusal), NOT an engine crash. Distinct
 * from {@link FeatureNotSupportedError} (a dialect/driver capability gap): this
 * is shape-capability. It extends {@link QueryEngineError} so pre-existing
 * `instanceof QueryEngineError` handling keeps working, but carries its own
 * name and code (`V8003 UNSUPPORTED_OPERATION`) so a deliberate refusal is
 * distinguishable from `V9001 INTERNAL_ERROR` programmatically and in logs.
 * Users can `instanceof UnsupportedOperationError` (exported from the package
 * root) to branch on it.
 */
export class UnsupportedOperationError extends QueryEngineError {
  static override readonly diagnosticName = "UnsupportedOperationError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    super(message, {
      ...options,
      code: VibORMErrorCode.UNSUPPORTED_OPERATION,
    });
  }
}

/**
 * Type guard for unsupported-operation (shape-capability) refusals
 */
export function isUnsupportedOperationError(
  error: unknown
): error is UnsupportedOperationError {
  return error instanceof UnsupportedOperationError;
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
