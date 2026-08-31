import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Every code {@link ConnectionError} can carry. `CLIENT_INITIALIZATION` is NOT here — it has
 * its own class ({@link ClientInitializationError}).
 */
export type ConnectionErrorCode =
  | typeof VibORMErrorCode.CONNECTION_FAILED
  | typeof VibORMErrorCode.CONNECTION_TIMEOUT
  | typeof VibORMErrorCode.CONNECTION_CLOSED;

/**
 * Connection-related errors
 */
export class ConnectionError extends VibORMError {
  static override readonly diagnosticName = "ConnectionError";

  /** Discriminant: one of {@link ConnectionErrorCode}, never a code outside the family. */
  declare readonly code: ConnectionErrorCode;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: ConnectionErrorCode | undefined;
    }
  ) {
    super(message, options?.code ?? VibORMErrorCode.CONNECTION_FAILED, options);
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

  /** Literal discriminant: this class always carries `CLIENT_INITIALIZATION`. */
  declare readonly code: typeof VibORMErrorCode.CLIENT_INITIALIZATION;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    super(message, VibORMErrorCode.CLIENT_INITIALIZATION, options);
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
 * Every code {@link QueryError} can carry.
 *
 * The `V2xxx` query family plus `INVALID_INPUT`, which the raw-SQL helpers raise through this
 * class when a caller hands `$queryRaw` something that is neither a tagged template nor an
 * `Sql` fragment, or a raw/provider parameter boundary refuses an invalid
 * `Date` (`client/raw.ts`, `drivers/provider-parameter-snapshot.ts`) — measured
 * at the construction sites, not assumed.
 */
export type QueryErrorCode =
  | typeof VibORMErrorCode.QUERY_FAILED
  | typeof VibORMErrorCode.QUERY_TIMEOUT
  | typeof VibORMErrorCode.QUERY_SYNTAX
  | typeof VibORMErrorCode.INVALID_INPUT;

/**
 * Query execution errors
 */
export class QueryError extends VibORMError {
  static override readonly diagnosticName = "QueryError";

  /** Discriminant: one of {@link QueryErrorCode}, never a code outside the family. */
  declare readonly code: QueryErrorCode;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: QueryErrorCode | undefined;
    }
  ) {
    super(message, options?.code ?? VibORMErrorCode.QUERY_FAILED, options);
  }
}

/**
 * Record not found (for OrThrow operations)
 */
export class NotFoundError extends VibORMError {
  static override readonly diagnosticName = "NotFoundError";

  /** Literal discriminant: this class always carries `RECORD_NOT_FOUND`. */
  declare readonly code: typeof VibORMErrorCode.RECORD_NOT_FOUND;

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
 * Every code {@link NestedWriteError} can carry.
 *
 * `NESTED_WRITE_ASSERTION_FAILED` is in the union even though
 * {@link NestedWriteAssertionError} owns that code as a class: the un-attributable batch floor
 * (`OperationExecutor.attributeGuardFailure`, `query-engine/batch-error-attribution.ts`)
 * deliberately re-raises the V7006 floor as a `NestedWriteError` so the surfaced error carries
 * the assertion code without claiming the driver-mapped class. Measured at the construction
 * sites; the two are told apart by class, not by code.
 */
export type NestedWriteErrorCode =
  | typeof VibORMErrorCode.NESTED_WRITE_FAILED
  | typeof VibORMErrorCode.NESTED_CREATE_FAILED
  | typeof VibORMErrorCode.NESTED_UPDATE_FAILED
  | typeof VibORMErrorCode.NESTED_DELETE_FAILED
  | typeof VibORMErrorCode.NESTED_CONNECT_FAILED
  | typeof VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED;

/**
 * Nested write operation errors
 */
export class NestedWriteError extends VibORMError {
  static override readonly diagnosticName = "NestedWriteError";

  /** Discriminant: one of {@link NestedWriteErrorCode}, never a code outside the family. */
  declare readonly code: NestedWriteErrorCode;

  constructor(
    message: string,
    relation: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
      code?: NestedWriteErrorCode | undefined;
    }
  ) {
    super(message, options?.code ?? VibORMErrorCode.NESTED_WRITE_FAILED, {
      cause: options?.cause,
      diagnostics: options?.diagnostics,
      meta: { ...options?.meta, relation },
    });
  }
}

/**
 * The batch assertion-abort floor sentence — one home for the three layers that
 * say it: the executor's guard-free-ladder floor, merged-batch attribution's
 * un-attributable floor, and driver error mapping's assertion translation.
 * The wording matches V1's frozen runtime verbatim; edit it nowhere else.
 */
export const NESTED_WRITE_ASSERTION_FLOOR_MESSAGE =
  "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.";

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

  /** Literal discriminant: this class always carries `NESTED_WRITE_ASSERTION_FAILED`. */
  declare readonly code: typeof VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    super(message, VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED, options);
  }
}

/**
 * Feature not supported errors
 */
export class FeatureNotSupportedError extends VibORMError {
  static override readonly diagnosticName = "FeatureNotSupportedError";

  /** Literal discriminant: this class always carries `FEATURE_NOT_SUPPORTED`. */
  declare readonly code: typeof VibORMErrorCode.FEATURE_NOT_SUPPORTED;

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
/** Every code {@link PendingOperationError} can carry. */
export type PendingOperationErrorCode =
  | typeof VibORMErrorCode.OPERATION_ALREADY_EXECUTED
  | typeof VibORMErrorCode.OPERATION_EXECUTION_CONFLICT
  | typeof VibORMErrorCode.OPERATION_CLIENT_MISMATCH
  | typeof VibORMErrorCode.OPERATION_SCOPE_MISMATCH;

export class PendingOperationError extends VibORMError {
  static override readonly diagnosticName = "PendingOperationError";

  /** Discriminant: one of {@link PendingOperationErrorCode}, never a code outside the family. */
  declare readonly code: PendingOperationErrorCode;

  constructor(
    message: string,
    code: PendingOperationErrorCode,
    options?: { meta?: VibORMErrorMeta }
  ) {
    super(message, code, options);
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
/**
 * Every code a {@link QueryEngineError} can carry — its own `INTERNAL_ERROR`, plus the
 * `UNSUPPORTED_OPERATION` its {@link UnsupportedOperationError} subclass narrows to. A wider
 * type here would be a lie about the class; a narrower one would make the subclass's `code`
 * an illegal override.
 */
export type QueryEngineErrorCode =
  | typeof VibORMErrorCode.INTERNAL_ERROR
  | typeof VibORMErrorCode.UNSUPPORTED_OPERATION;

export class QueryEngineError extends VibORMError {
  // Annotated `string` (not the literal) so a subclass may narrow it — the
  // pattern VibORMError itself uses for its subclasses.
  static override readonly diagnosticName: string = "QueryEngineError";

  /**
   * Discriminant. `INTERNAL_ERROR` for a bare engine error; the
   * {@link UnsupportedOperationError} subclass narrows it to `UNSUPPORTED_OPERATION`, which is
   * why this is the family and not a single literal — a code check alone cannot separate the
   * two, so {@link classifyFailure} separates them by class.
   */
  declare readonly code: QueryEngineErrorCode;

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
      /** Subclass seam: a distinct taxonomy code (default INTERNAL_ERROR). */
      code?: QueryEngineErrorCode | undefined;
    }
  ) {
    super(message, options?.code ?? VibORMErrorCode.INTERNAL_ERROR, options);
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

  /** Literal discriminant: this class always carries `UNSUPPORTED_OPERATION`. */
  declare readonly code: typeof VibORMErrorCode.UNSUPPORTED_OPERATION;

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
