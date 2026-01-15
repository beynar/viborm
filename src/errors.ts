/**
 * VibORM Error Hierarchy
 *
 * Standardized error classes with error codes for programmatic handling.
 * This is the single source of truth for all VibORM errors.
 */

import type { Operation } from "./query-engine/types";

/**
 * Error codes for programmatic error handling
 */
export enum VibORMErrorCode {
  // Connection errors (1xxx)
  CONNECTION_FAILED = "V1001",
  CONNECTION_TIMEOUT = "V1002",
  CONNECTION_CLOSED = "V1003",

  // Query errors (2xxx)
  QUERY_FAILED = "V2001",
  QUERY_TIMEOUT = "V2002",
  QUERY_SYNTAX = "V2003",

  // Constraint errors (3xxx)
  UNIQUE_CONSTRAINT = "V3001",
  FOREIGN_KEY_CONSTRAINT = "V3002",
  NOT_NULL_CONSTRAINT = "V3003",
  CHECK_CONSTRAINT = "V3004",

  // Validation errors (4xxx)
  VALIDATION_FAILED = "V4001",
  INVALID_INPUT = "V4002",
  MISSING_REQUIRED = "V4003",

  // Transaction errors (5xxx)
  TRANSACTION_FAILED = "V5001",
  TRANSACTION_TIMEOUT = "V5002",
  DEADLOCK = "V5003",
  SERIALIZATION_FAILURE = "V5004",

  // Not found errors (6xxx)
  RECORD_NOT_FOUND = "V6001",
  MODEL_NOT_FOUND = "V6002",
  RELATION_NOT_FOUND = "V6003",

  // Nested write errors (7xxx)
  NESTED_WRITE_FAILED = "V7001",
  NESTED_CREATE_FAILED = "V7002",
  NESTED_UPDATE_FAILED = "V7003",
  NESTED_DELETE_FAILED = "V7004",
  NESTED_CONNECT_FAILED = "V7005",

  // Feature errors (8xxx)
  FEATURE_NOT_SUPPORTED = "V8001",
  DRIVER_NOT_SUPPORTED = "V8002",

  // Internal errors (9xxx)
  INTERNAL_ERROR = "V9001",
  SCHEMA_ERROR = "V9002",
}

/**
 * Error metadata for additional context
 */
export interface VibORMErrorMeta {
  /** Model name if applicable */
  model?: string;
  /** Operation being performed */
  operation?: string;
  /** Relation name if applicable */
  relation?: string;
  /** Table name */
  table?: string;
  /** Column names */
  columns?: string[];
  /** Constraint name */
  constraint?: string;
  /** SQL query (redacted by default) */
  query?: string;
  /** Query parameters */
  params?: unknown[];
  /** Feature name */
  feature?: string;
  /** Method name */
  method?: string;
  /** Additional context */
  [key: string]: unknown;
}

/**
 * Base error class for all VibORM errors
 */
export class VibORMError extends Error {
  /** Error code for programmatic handling */
  readonly code: VibORMErrorCode;
  /** Original cause if wrapping another error */
  readonly originalCause?: Error | undefined;
  /** Additional metadata */
  readonly meta: VibORMErrorMeta;
  /** Timestamp when error occurred */
  readonly timestamp: Date;

  constructor(
    message: string,
    code: VibORMErrorCode,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta | undefined;
    }
  ) {
    super(message);
    this.name = "VibORMError";
    this.code = code;
    this.originalCause = options?.cause;
    this.meta = options?.meta ?? {};
    this.timestamp = new Date();

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Check if error is retryable (deadlock, serialization failure)
   */
  isRetryable(): boolean {
    return [
      VibORMErrorCode.DEADLOCK,
      VibORMErrorCode.SERIALIZATION_FAILURE,
      VibORMErrorCode.CONNECTION_TIMEOUT,
      VibORMErrorCode.QUERY_TIMEOUT,
    ].includes(this.code);
  }

  /**
   * Convert to JSON for logging/serialization
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      meta: this.meta,
      timestamp: this.timestamp.toISOString(),
      cause: this.originalCause?.message,
    };
  }
}

// ============================================================
// CONNECTION ERRORS
// ============================================================

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

// ============================================================
// QUERY ERRORS
// ============================================================

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
 * Unique constraint violation
 */
export class UniqueConstraintError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta & {
        constraint?: string;
        table?: string;
        columns?: string[];
      };
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.UNIQUE_CONSTRAINT, opts);
    this.name = "UniqueConstraintError";
  }
}

/**
 * Foreign key constraint violation
 */
export class ForeignKeyError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta & { constraint?: string };
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.FOREIGN_KEY_CONSTRAINT, opts);
    this.name = "ForeignKeyError";
  }
}

// ============================================================
// VALIDATION ERRORS
// ============================================================

/**
 * Validation issue details
 */
export interface ValidationIssue {
  path: string;
  message: string;
}

/**
 * Input validation errors
 */
export class ValidationError extends VibORMError {
  /** Validation issues */
  readonly issues: ValidationIssue[];
  /** Operation that failed validation */
  readonly operation: Operation;

  constructor(
    operation: Operation,
    issues: ValidationIssue[],
    options?: { meta?: VibORMErrorMeta }
  ) {
    const issuesSummary =
      issues.length === 1
        ? issues[0]!.message
        : `${issues.length} validation errors`;
    super(
      `Validation failed for ${operation}: ${issuesSummary}`,
      VibORMErrorCode.VALIDATION_FAILED,
      {
        meta: { ...options?.meta, operation },
      }
    );
    this.name = "ValidationError";
    this.issues = issues;
    this.operation = operation;
  }
}

// ============================================================
// TRANSACTION ERRORS
// ============================================================

/**
 * Transaction errors
 */
export class TransactionError extends VibORMError {
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
    super(message, options?.code ?? VibORMErrorCode.TRANSACTION_FAILED, opts);
    this.name = "TransactionError";
  }
}

// ============================================================
// NOT FOUND ERRORS
// ============================================================

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

// ============================================================
// NESTED WRITE ERRORS
// ============================================================

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

// ============================================================
// FEATURE ERRORS
// ============================================================

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

// ============================================================
// INTERNAL ERRORS
// ============================================================

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

// ============================================================
// ERROR UTILITIES
// ============================================================

/**
 * Type guard to check if error is a VibORMError
 */
export function isVibORMError(error: unknown): error is VibORMError {
  return error instanceof VibORMError;
}

/**
 * Type guard for specific error codes
 */
export function hasErrorCode(
  error: unknown,
  code: VibORMErrorCode
): error is VibORMError {
  return isVibORMError(error) && error.code === code;
}

/**
 * Check if error is retryable
 */
export function isRetryableError(error: unknown): boolean {
  if (isVibORMError(error)) {
    return error.isRetryable();
  }

  // Also check for database-specific error codes
  if (error instanceof Error && "code" in error) {
    const retryableCodes = ["40001", "40P01", "SQLITE_BUSY"];
    return retryableCodes.includes((error as Error & { code: string }).code);
  }

  return false;
}

/**
 * Type guard for unique constraint errors
 */
export function isUniqueConstraintError(
  error: unknown
): error is UniqueConstraintError {
  return error instanceof UniqueConstraintError;
}

/**
 * Type guard for foreign key errors
 */
export function isForeignKeyError(error: unknown): error is ForeignKeyError {
  return error instanceof ForeignKeyError;
}

/**
 * Type guard for not found errors
 */
export function isNotFoundError(error: unknown): error is NotFoundError {
  return error instanceof NotFoundError;
}

/**
 * Type guard for validation errors
 */
export function isValidationError(error: unknown): error is ValidationError {
  return error instanceof ValidationError;
}

/**
 * Wrap unknown error in VibORMError
 */
export function wrapError(
  error: unknown,
  code: VibORMErrorCode = VibORMErrorCode.INTERNAL_ERROR,
  meta?: VibORMErrorMeta
): VibORMError {
  if (isVibORMError(error)) {
    return error;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  return new VibORMError(cause.message, code, { cause, meta });
}

// ============================================================
// UNSUPPORTED FEATURE HELPERS
// ============================================================

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
