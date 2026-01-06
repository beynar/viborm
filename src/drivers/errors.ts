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

/**
 * Feature not supported by driver
 *
 * Thrown when a driver doesn't support a specific feature
 * (e.g., vector operations without pgvector extension).
 */
export class FeatureNotSupportedError extends DriverError {
  constructor(
    public readonly feature: string,
    public readonly method: string,
    suggestion?: string
  ) {
    const msg = suggestion
      ? `${feature}.${method} is not supported. ${suggestion}`
      : `${feature}.${method} is not supported by this driver.`;
    super(msg);
    this.name = "FeatureNotSupportedError";
  }
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
