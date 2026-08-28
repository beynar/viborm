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
  /** Last confirmed dispatch or step identity */
  lastConfirmedStep?: string;
  /** Estate digest involved in the refusal */
  estateHash?: string;
  /** State digest involved in the refusal */
  stateId?: string;
  /** Push plan digest involved in the refusal */
  planHash?: string;
  /** Honest effect classification after a non-transactional failure */
  effectState?: "none" | "committed" | "partial" | "may-have-committed";
  /** True when some provider work may already have committed */
  partial?: boolean;
}

/**
 * Every code {@link MigrationError} can carry.
 *
 * The `MIGRATION_*` family plus four codes the migration layer genuinely raises through this
 * class — measured, not assumed: `INVALID_INPUT` (`migrations/utils.ts`, `drivers/base.ts`),
 * `FEATURE_NOT_SUPPORTED` (unsupported index type, SQLite table recreation),
 * `DRIVER_NOT_SUPPORTED` (`drivers/index.ts`) and `INTERNAL_ERROR` (unreachable operation
 * kinds). A code outside this union is a compile error at the construction site.
 */
export type MigrationErrorCode =
  | typeof VibORMErrorCode.MIGRATION_FAILED
  | typeof VibORMErrorCode.MIGRATION_NOT_FOUND
  | typeof VibORMErrorCode.MIGRATION_CHECKSUM_MISMATCH
  | typeof VibORMErrorCode.MIGRATION_DIALECT_MISMATCH
  | typeof VibORMErrorCode.MIGRATION_LOCK_FAILED
  | typeof VibORMErrorCode.MIGRATION_ALREADY_APPLIED
  | typeof VibORMErrorCode.MIGRATION_OUT_OF_ORDER
  | typeof VibORMErrorCode.MIGRATION_FILE_NOT_FOUND
  | typeof VibORMErrorCode.MIGRATION_INVALID_STATE
  | typeof VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED
  | typeof VibORMErrorCode.MIGRATION_STORAGE_REQUIRED
  | typeof VibORMErrorCode.MIGRATION_INVALID_ESTATE
  | typeof VibORMErrorCode.MIGRATION_PATH_REQUIRED
  | typeof VibORMErrorCode.MIGRATION_DRIFT
  | typeof VibORMErrorCode.MIGRATION_MARKER_CONFLICT
  | typeof VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT
  | typeof VibORMErrorCode.MIGRATION_CONSENT_REQUIRED
  | typeof VibORMErrorCode.MIGRATION_CONSENT_MISMATCH
  | typeof VibORMErrorCode.MIGRATION_PARTIAL_EFFECT
  | typeof VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT
  | typeof VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER
  | typeof VibORMErrorCode.MIGRATION_CORRUPTION
  | typeof VibORMErrorCode.INVALID_INPUT
  | typeof VibORMErrorCode.FEATURE_NOT_SUPPORTED
  | typeof VibORMErrorCode.DRIVER_NOT_SUPPORTED
  | typeof VibORMErrorCode.INTERNAL_ERROR;

/**
 * Migration-related errors
 */
export class MigrationError extends VibORMError {
  static override readonly diagnosticName = "MigrationError";

  /** Discriminant: one of {@link MigrationErrorCode}, never a code outside the family. */
  declare readonly code: MigrationErrorCode;

  constructor(
    message: string,
    code: MigrationErrorCode = VibORMErrorCode.MIGRATION_FAILED,
    options?: {
      cause?: Error | undefined;
      meta?: MigrationErrorMeta | undefined;
    }
  ) {
    const opts: { cause?: Error; meta?: VibORMErrorMeta } = {};
    if (options?.cause) opts.cause = options.cause;
    if (options?.meta) opts.meta = options.meta;
    super(message, code, opts);
  }
}

/**
 * Type guard for migration errors
 */
export function isMigrationError(error: unknown): error is MigrationError {
  return error instanceof MigrationError;
}
