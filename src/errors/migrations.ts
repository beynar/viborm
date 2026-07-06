import { VibORMError, VibORMErrorCode, type VibORMErrorMeta } from "./base";

/**
 * Migration error metadata
 */
export interface MigrationErrorMeta extends VibORMErrorMeta {
  /** Name of the migration */
  migrationName?: string;
  /** Expected checksum (from database) */
  expectedChecksum?: string;
  /** Actual checksum (from file) */
  actualChecksum?: string;
  /** Migration index */
  migrationIndex?: number;
  /** Directory path */
  migrationsDir?: string;
}

/**
 * Migration-related errors
 */
export class MigrationError extends VibORMError {
  constructor(
    message: string,
    code: VibORMErrorCode = VibORMErrorCode.MIGRATION_FAILED,
    options?: {
      cause?: Error | undefined;
      meta?: MigrationErrorMeta | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, code, opts);
    this.name = "MigrationError";
  }
}

/**
 * Type guard for migration errors
 */
export function isMigrationError(error: unknown): error is MigrationError {
  return error instanceof MigrationError;
}
