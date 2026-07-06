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
  INVALID_TRANSACTION_INPUT = "V5005",

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
  NESTED_WRITE_ASSERTION_FAILED = "V7006",

  // Feature errors (8xxx)
  FEATURE_NOT_SUPPORTED = "V8001",
  DRIVER_NOT_SUPPORTED = "V8002",

  // Cache errors (10xxx)
  CACHE_INVALID_TTL = "V10001",
  CACHE_INVALID_KEY = "V10002",
  CACHE_OPERATION_NOT_CACHEABLE = "V10003",
  CACHE_CONFIGURATION = "V10004",

  // Migration errors (11xxx)
  MIGRATION_FAILED = "V11001",
  MIGRATION_NOT_FOUND = "V11002",
  MIGRATION_CHECKSUM_MISMATCH = "V11003",
  MIGRATION_DIALECT_MISMATCH = "V11004",
  MIGRATION_LOCK_FAILED = "V11005",
  MIGRATION_ALREADY_APPLIED = "V11006",
  MIGRATION_OUT_OF_ORDER = "V11007",
  MIGRATION_FILE_NOT_FOUND = "V11008",
  MIGRATION_INVALID_STATE = "V11009",
  MIGRATION_DESTRUCTIVE_REJECTED = "V11010",
  MIGRATION_STORAGE_REQUIRED = "V11011",

  // Pending operation errors (12xxx)
  OPERATION_ALREADY_EXECUTED = "V12001",
  OPERATION_EXECUTION_CONFLICT = "V12002",
  OPERATION_CLIENT_MISMATCH = "V12003",

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
    const code = error.code;
    return typeof code === "string" && retryableCodes.includes(code);
  }

  return false;
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
