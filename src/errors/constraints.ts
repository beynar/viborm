import { coded, VibORMErrorCode } from "./base";

/**
 * Unique constraint violation
 */
export class UniqueConstraintError extends coded<
  typeof VibORMErrorCode.UNIQUE_CONSTRAINT
>("UniqueConstraintError", VibORMErrorCode.UNIQUE_CONSTRAINT) {}

/**
 * Foreign key constraint violation
 */
export class ForeignKeyError extends coded<
  typeof VibORMErrorCode.FOREIGN_KEY_CONSTRAINT
>("ForeignKeyError", VibORMErrorCode.FOREIGN_KEY_CONSTRAINT) {}

/**
 * Not-null constraint violation
 */
export class NotNullConstraintError extends coded<
  typeof VibORMErrorCode.NOT_NULL_CONSTRAINT
>("NotNullConstraintError", VibORMErrorCode.NOT_NULL_CONSTRAINT) {}

/**
 * Check constraint violation
 */
export class CheckConstraintError extends coded<
  typeof VibORMErrorCode.CHECK_CONSTRAINT
>("CheckConstraintError", VibORMErrorCode.CHECK_CONSTRAINT) {}

/**
 * Value too long for the column's declared type (Prisma P2000)
 *
 * Raised where the database enforces a column length: PostgreSQL SQLSTATE 22001
 * (`string_data_right_truncation`) and MySQL errno 1406 (`ER_DATA_TOO_LONG`).
 *
 * **SQLite raises nothing comparable.** SQLite ignores declared type lengths entirely
 * (`VARCHAR(5)` stores any string), so an over-long value is written, not rejected; the only
 * related error, `SQLITE_TOOBIG`, fires at the ~1GB `SQLITE_MAX_LENGTH` limit and means a
 * different thing. Prisma behaves the same way — quaint's SQLite connector has no arm for it,
 * so it falls through to a generic query error rather than P2000
 * (`quaint/src/connector/sqlite/error.rs`). VibORM therefore keeps `QueryError` on SQLite
 * instead of manufacturing a P2000 that the engine cannot honestly promise.
 */
export class ValueTooLongError extends coded<
  typeof VibORMErrorCode.VALUE_TOO_LONG
>("ValueTooLongError", VibORMErrorCode.VALUE_TOO_LONG) {}

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

/**
 * Type guard for value-too-long errors
 */
export function isValueTooLongError(
  error: unknown
): error is ValueTooLongError {
  return error instanceof ValueTooLongError;
}
