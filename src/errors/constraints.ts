import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

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

/**
 * Not-null constraint violation
 */
export class NotNullConstraintError extends VibORMError {
  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      meta?: VibORMErrorMeta & {
        table?: string;
        columns?: string[];
      };
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, VibORMErrorCode.NOT_NULL_CONSTRAINT, opts);
    this.name = "NotNullConstraintError";
  }
}

/**
 * Check constraint violation
 */
export class CheckConstraintError extends VibORMError {
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
    super(message, VibORMErrorCode.CHECK_CONSTRAINT, opts);
    this.name = "CheckConstraintError";
  }
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
 * Type guard for not-null constraint errors
 */
export function isNotNullConstraintError(
  error: unknown
): error is NotNullConstraintError {
  return error instanceof NotNullConstraintError;
}

/**
 * Type guard for check constraint errors
 */
export function isCheckConstraintError(
  error: unknown
): error is CheckConstraintError {
  return error instanceof CheckConstraintError;
}
