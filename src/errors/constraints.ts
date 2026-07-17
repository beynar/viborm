import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";
import type { DiagnosticDisclosure } from "./diagnostics";

/**
 * Unique constraint violation
 */
export class UniqueConstraintError extends VibORMError {
  static override readonly diagnosticName = "UniqueConstraintError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta & {
        constraint?: string;
        table?: string;
        columns?: string[];
      };
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
    super(message, VibORMErrorCode.UNIQUE_CONSTRAINT, opts);
  }
}

/**
 * Foreign key constraint violation
 */
export class ForeignKeyError extends VibORMError {
  static override readonly diagnosticName = "ForeignKeyError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta & { constraint?: string };
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
    super(message, VibORMErrorCode.FOREIGN_KEY_CONSTRAINT, opts);
  }
}

/**
 * Not-null constraint violation
 */
export class NotNullConstraintError extends VibORMError {
  static override readonly diagnosticName = "NotNullConstraintError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta & {
        table?: string;
        columns?: string[];
      };
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
    super(message, VibORMErrorCode.NOT_NULL_CONSTRAINT, opts);
  }
}

/**
 * Check constraint violation
 */
export class CheckConstraintError extends VibORMError {
  static override readonly diagnosticName = "CheckConstraintError";

  constructor(
    message: string,
    options?: {
      cause?: Error | undefined;
      diagnostics?: DiagnosticDisclosure | undefined;
      meta?: VibORMErrorMeta & { constraint?: string };
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
    super(message, VibORMErrorCode.CHECK_CONSTRAINT, opts);
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
