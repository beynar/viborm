/**
 * Driver Errors
 *
 * Standardized errors for database operations.
 */

/**
 * Base driver error
 */
export class DriverError extends Error {
  readonly cause?: Error | undefined;
  readonly code?: string | undefined;

  constructor(
    message: string,
    options?: { cause?: Error | undefined; code?: string | undefined }
  ) {
    super(message);
    this.name = "DriverError";
    this.cause = options?.cause;
    this.code = options?.code;
  }
}

/**
 * Connection failed
 */
export class ConnectionError extends DriverError {
  constructor(
    message: string,
    options?: { cause?: Error | undefined; code?: string | undefined }
  ) {
    super(message, options);
    this.name = "ConnectionError";
  }
}

/**
 * Query execution failed
 */
export class QueryError extends DriverError {
  readonly query?: string | undefined;
  readonly params?: unknown[] | undefined;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      code?: string;
      query?: string;
      params?: unknown[];
    }
  ) {
    super(message, {
      cause: options?.cause ?? undefined,
      code: options?.code ?? undefined,
    });
    this.name = "QueryError";
    this.query = options?.query ?? undefined;
    this.params = options?.params ?? undefined;
  }
}

/**
 * Unique constraint violation
 */
export class UniqueConstraintError extends QueryError {
  readonly constraint?: string | undefined;
  readonly table?: string | undefined;
  readonly columns?: string[] | undefined;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      code?: string;
      query?: string;
      params?: unknown[];
      constraint?: string;
      table?: string;
      columns?: string[];
    }
  ) {
    super(message, options);
    this.name = "UniqueConstraintError";
    this.constraint = options?.constraint;
    this.table = options?.table;
    this.columns = options?.columns;
  }
}

/**
 * Foreign key constraint violation
 */
export class ForeignKeyError extends QueryError {
  readonly constraint?: string | undefined;

  constructor(
    message: string,
    options?: {
      cause?: Error;
      code?: string;
      query?: string;
      params?: unknown[];
      constraint?: string;
    }
  ) {
    super(message, options);
    this.name = "ForeignKeyError";
    this.constraint = options?.constraint;
  }
}

/**
 * Transaction error
 */
export class TransactionError extends DriverError {
  constructor(message: string, options?: { cause?: Error; code?: string }) {
    super(message, options);
    this.name = "TransactionError";
  }
}

/**
 * Check if error is retryable (deadlock, serialization failure)
 */
export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof DriverError)) {
    return false;
  }
  const retryableCodes = ["40001", "40P01", "SQLITE_BUSY"];
  return error.code ? retryableCodes.includes(error.code) : false;
}

/**
 * Check if error is a unique constraint violation
 */
export function isUniqueConstraintError(
  error: unknown
): error is UniqueConstraintError {
  return error instanceof UniqueConstraintError;
}
