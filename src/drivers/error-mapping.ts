import {
  CheckConstraintError,
  ConnectionError,
  type DiagnosticDisclosure,
  ForeignKeyError,
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  ValueTooLongError,
  type VibORMError,
  VibORMErrorCode,
  type VibORMErrorMeta,
} from "@errors";
import {
  attachExecutionContext,
  buildMeta,
  type DriverErrorContext,
  type DriverErrorShape,
} from "./driver-error-context";
import type { Dialect } from "./types";

const POSTGRES_UNIQUE = "23505";
const POSTGRES_FOREIGN_KEY = "23503";
const POSTGRES_NOT_NULL = "23502";
const POSTGRES_CHECK = "23514";
// string_data_right_truncation — Prisma maps this SQLSTATE to LengthMismatch/P2000
// (quaint/src/connector/postgres/error.rs)
const POSTGRES_VALUE_TOO_LONG = "22001";
const POSTGRES_SERIALIZATION = "40001";
const POSTGRES_DEADLOCK = "40P01";

const MYSQL_UNIQUE = 1062;
const MYSQL_FOREIGN_KEY = 1452;
const MYSQL_FOREIGN_KEY_ROW_IS_REFERENCED = 1451;
const MYSQL_NOT_NULL = 1048;
const MYSQL_CHECK = 3819;
// ER_DATA_TOO_LONG — Prisma maps errno 1406 to LengthMismatch/P2000
// (quaint/src/connector/mysql/error.rs). SQLite has no counterpart: it does not enforce
// declared column lengths, and quaint's SQLite connector leaves SQLITE_TOOBIG unmapped.
const MYSQL_DATA_TOO_LONG = 1406;
const MYSQL_DEADLOCK = 1213;
const MYSQL_LOCK_WAIT_TIMEOUT = 1205;
// Stop at ":" so D1's "users.email: SQLITE_CONSTRAINT" suffix isn't captured
const SQLITE_CONSTRAINT_COLUMNS_PATTERN = /constraint failed: ([^:]+)/;
const MYSQL_ERRNO_IN_MESSAGE_PATTERN = /\(errno (\d+)\)/;
// Batch-plan assertions (adapter.assertions) fail on purpose with a
// dialect-specific trick: division by zero on PG (SQLSTATE 22012), invalid
// JSON via JSON_EXTRACT/json_extract on MySQL (errno 3141) and SQLite
// ("malformed JSON"). The statements are identifiable by their column alias.
export const ASSERTION_MARKER = "__viborm_assert__";
const POSTGRES_DIVISION_BY_ZERO = "22012";
const MYSQL_INVALID_JSON_TEXT = 3141;

const JSON_ACCESS_SIGNATURE = /json|->/i;

const FOREIGN_ASSERTION_SIGNATURE: Record<Dialect, RegExp> = {
  postgresql: /[/%]/,
  mysql: JSON_ACCESS_SIGNATURE,
  sqlite: JSON_ACCESS_SIGNATURE,
};

/**
 * Report whether an ordinary statement can raise the same provider error as a
 * batch assertion. Assertion statements carry {@link ASSERTION_MARKER}; all
 * other statements are checked against the executing dialect's failure
 * signature. A conservative match leaves the raw provider error unattributed.
 */
export function batchMayContainAssertionCollision(
  statements: readonly { readonly sql: string }[],
  dialect: Dialect
): boolean {
  const signature = FOREIGN_ASSERTION_SIGNATURE[dialect];
  for (const statement of statements) {
    if (statement.sql.includes(ASSERTION_MARKER)) continue;
    if (signature.test(statement.sql)) return true;
  }
  return false;
}

function isAssertionFailure(
  code: string | number | undefined,
  errno: number | undefined,
  message: string
): boolean {
  return (
    code === POSTGRES_DIVISION_BY_ZERO ||
    code === "ER_INVALID_JSON_TEXT_IN_PARAM" ||
    errno === MYSQL_INVALID_JSON_TEXT ||
    message.includes("division by zero") ||
    message.includes("malformed JSON") ||
    message.includes("Invalid JSON text")
  );
}

/**
 * Every error class {@link mapProviderError} constructs — the driver layer's failure
 * vocabulary, named so it is visible at the call sites instead of erased to `Error`.
 *
 * The members are disjoint by `code` — each class carries its literal — so this union is a
 * discriminated union: `if (failure.code === VibORMErrorCode.UNIQUE_CONSTRAINT)` selects
 * `UniqueConstraintError`, and an exhaustive `switch` over the codes bottoms out at `never`.
 *
 * `mapProviderError` is annotated with it, which is the point: adding a ninth class to the
 * mapper without adding it here is a compile error, not a silently widened return.
 */
export type DriverFailure =
  | CheckConstraintError
  | ForeignKeyError
  | NestedWriteAssertionError
  | NotNullConstraintError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | ValueTooLongError;

/**
 * What {@link normalizeDriverError} can hand back.
 *
 * Two arms, and the type is the union of both. A raw provider error is mapped to a
 * {@link DriverFailure}. An error that is ALREADY a VibORM error is passed through with
 * execution context attached — and that arm is honestly `VibORMError`, not `DriverFailure`,
 * for two independent reasons: the incoming error can be any VibORM error the layers above
 * threw (a `ValidationError`, an engine refusal), and `attachExecutionContext` clones through
 * `getCloneConstructor`, whose prototype table does not list every class — a re-normalized
 * `ValueTooLongError` comes back as a bare `VibORMError` (measured, `driver-error-context.ts`).
 * Typing the whole function `DriverFailure` would be a claim neither arm can keep.
 */
export type NormalizedDriverError = DriverFailure | VibORMError;

export function normalizeDriverError(
  error: unknown,
  context: DriverErrorContext
): NormalizedDriverError {
  if (isKnownVibORMError(error)) {
    return attachExecutionContext(error, context);
  }
  return mapProviderError(error, context);
}

/**
 * Map a raw provider error onto the {@link DriverFailure} vocabulary. Split out of
 * {@link normalizeDriverError} so the constructed union has a return type to be checked
 * against — the passthrough arm above cannot carry that annotation, and a function has one
 * return type. The body is the mapping exactly as it was; only its type is new.
 */
function mapProviderError(
  error: unknown,
  context: DriverErrorContext
): DriverFailure {
  const cause = toError(error);
  const rawMessage = getErrorMessage(cause);
  const dbError = readDriverErrorShape(error);
  const meta = buildMeta(dbError, context, rawMessage);
  const code = dbError.code;
  const errno = dbError.errno ?? parseMessageErrno(rawMessage);
  const diagnostics = context.diagnostics;
  if (errno !== undefined && meta.providerErrno === undefined) {
    meta.providerErrno = errno;
  }

  if (
    context.query?.includes(ASSERTION_MARKER) &&
    isAssertionFailure(code, errno, rawMessage)
  ) {
    return new NestedWriteAssertionError(NESTED_WRITE_ASSERTION_FLOOR_MESSAGE, {
      cause,
      diagnostics,
      meta,
    });
  }

  if (code === POSTGRES_UNIQUE || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return new UniqueConstraintError("Unique constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (
    code === POSTGRES_FOREIGN_KEY ||
    code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  ) {
    return new ForeignKeyError("Foreign key constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (code === POSTGRES_NOT_NULL || code === "SQLITE_CONSTRAINT_NOTNULL") {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (code === POSTGRES_CHECK || code === "SQLITE_CONSTRAINT_CHECK") {
    return new CheckConstraintError("Check constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (code === POSTGRES_VALUE_TOO_LONG) {
    return new ValueTooLongError("Value too long for column type", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (code === POSTGRES_SERIALIZATION) {
    return new TransactionError("Transaction serialization failure", {
      cause,
      diagnostics,
      meta,
      code: VibORMErrorCode.SERIALIZATION_FAILURE,
    });
  }

  if (code === POSTGRES_DEADLOCK) {
    return new TransactionError("Transaction deadlock detected", {
      cause,
      diagnostics,
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  if (errno === MYSQL_UNIQUE || code === "ER_DUP_ENTRY") {
    return new UniqueConstraintError("Unique constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (
    errno === MYSQL_FOREIGN_KEY ||
    errno === MYSQL_FOREIGN_KEY_ROW_IS_REFERENCED ||
    code === "ER_NO_REFERENCED_ROW_2" ||
    code === "ER_ROW_IS_REFERENCED_2"
  ) {
    return new ForeignKeyError("Foreign key constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (errno === MYSQL_NOT_NULL || code === "ER_BAD_NULL_ERROR") {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (errno === MYSQL_CHECK || code === "ER_CHECK_CONSTRAINT_VIOLATED") {
    return new CheckConstraintError("Check constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (errno === MYSQL_DATA_TOO_LONG || code === "ER_DATA_TOO_LONG") {
    return new ValueTooLongError("Value too long for column type", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (
    errno === MYSQL_DEADLOCK ||
    errno === MYSQL_LOCK_WAIT_TIMEOUT ||
    code === "ER_LOCK_DEADLOCK" ||
    code === "ER_LOCK_WAIT_TIMEOUT"
  ) {
    return new TransactionError("Transaction deadlock detected", {
      cause,
      diagnostics,
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    rawMessage.includes("SQLITE_BUSY") ||
    rawMessage.includes("SQLITE_LOCKED")
  ) {
    // DEADLOCK code so the write-race retry logic treats it as retryable
    return new TransactionError("Database is locked", {
      cause,
      diagnostics,
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  const sqliteConstraint = mapSQLiteConstraint(
    rawMessage,
    meta,
    cause,
    diagnostics
  );
  if (sqliteConstraint) {
    return sqliteConstraint;
  }

  return new QueryError("Query execution failed", {
    cause,
    diagnostics,
    meta,
  });
}

/**
 * What {@link normalizeDriverConnectionError} can hand back — the connection variant of
 * {@link NormalizedDriverError}. The constructed arm is exactly {@link ConnectionError}; the
 * passthrough arm is `VibORMError` for the same two reasons documented there.
 */
export type NormalizedConnectionError = ConnectionError | VibORMError;

export function normalizeDriverConnectionError(
  error: unknown,
  context: DriverErrorContext,
  message = "Database connection failed"
): NormalizedConnectionError {
  if (isKnownVibORMError(error)) {
    return attachExecutionContext(error, context);
  }

  const cause = toError(error);
  const rawMessage = getErrorMessage(cause);
  const dbError = readDriverErrorShape(error);
  const meta = buildMeta(dbError, context, rawMessage);
  const errno = dbError.errno ?? parseMessageErrno(rawMessage);
  if (errno !== undefined && meta.providerErrno === undefined) {
    meta.providerErrno = errno;
  }
  return new ConnectionError(message, {
    cause,
    diagnostics: context.diagnostics,
    meta,
  });
}

function isKnownVibORMError(error: unknown): error is VibORMError {
  try {
    return isVibORMError(error);
  } catch {
    return false;
  }
}

function toError(error: unknown): Error {
  try {
    return error instanceof Error ? error : new Error("Unknown provider error");
  } catch {
    return new Error("Unknown provider error");
  }
}

function getErrorMessage(error: Error): string {
  try {
    return typeof error.message === "string"
      ? error.message
      : "Unknown provider error";
  } catch {
    return "Unknown provider error";
  }
}

function readDriverErrorShape(error: unknown): DriverErrorShape {
  if ((typeof error !== "object" && typeof error !== "function") || !error) {
    return {};
  }
  const body = readProperty(error, "body");
  return {
    code: readStringOrNumber(error, "code"),
    bodyCode:
      body && (typeof body === "object" || typeof body === "function")
        ? readStringOrNumber(body, "code")
        : undefined,
    errno: readNumber(error, "errno"),
    constraint: readString(error, "constraint"),
    table: readString(error, "table"),
    column: readString(error, "column"),
    constraint_name: readString(error, "constraint_name"),
    table_name: readString(error, "table_name"),
    column_name: readString(error, "column_name"),
    sqlState: readString(error, "sqlState"),
    sqlstate: readString(error, "sqlstate"),
    status: readStringOrNumber(error, "status"),
    statusCode: readStringOrNumber(error, "statusCode"),
  };
}

function readString(value: object, key: string): string | undefined {
  const member = readProperty(value, key);
  return typeof member === "string" ? member : undefined;
}

function readNumber(value: object, key: string): number | undefined {
  const member = readProperty(value, key);
  return typeof member === "number" ? member : undefined;
}

function readStringOrNumber(
  value: object,
  key: string
): string | number | undefined {
  const member = readProperty(value, key);
  return typeof member === "string" || typeof member === "number"
    ? member
    : undefined;
}

function readProperty(value: object, key: string): unknown {
  try {
    return Reflect.get(value, key);
  } catch {
    return undefined;
  }
}

function parseMessageErrno(message: string): number | undefined {
  const match = MYSQL_ERRNO_IN_MESSAGE_PATTERN.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

function mapSQLiteConstraint(
  message: string,
  meta: VibORMErrorMeta,
  cause: Error,
  diagnostics: DiagnosticDisclosure | undefined
):
  | CheckConstraintError
  | ForeignKeyError
  | NotNullConstraintError
  | UniqueConstraintError
  | undefined {
  const isSQLiteConstraint =
    message.includes("SQLITE_CONSTRAINT") ||
    message.includes("UNIQUE constraint failed") ||
    message.includes("FOREIGN KEY constraint failed") ||
    message.includes("NOT NULL constraint failed") ||
    message.includes("CHECK constraint failed");

  if (!isSQLiteConstraint) {
    return undefined;
  }

  if (message.includes("UNIQUE constraint failed")) {
    return new UniqueConstraintError("Unique constraint violation", {
      cause,
      diagnostics,
      meta: { ...meta, columns: parseSQLiteColumns(message) },
    });
  }

  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ForeignKeyError("Foreign key constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  if (message.includes("NOT NULL constraint failed")) {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      diagnostics,
      meta: { ...meta, columns: parseSQLiteColumns(message) },
    });
  }

  if (message.includes("CHECK constraint failed")) {
    return new CheckConstraintError("Check constraint violation", {
      cause,
      diagnostics,
      meta,
    });
  }

  return undefined;
}

function parseSQLiteColumns(message: string): string[] | undefined {
  const match = SQLITE_CONSTRAINT_COLUMNS_PATTERN.exec(message);
  if (!match) {
    return undefined;
  }

  const columns = match[1];
  if (!columns) {
    return undefined;
  }

  return columns
    .split(",")
    .map((column) => column.trim())
    .filter((column) => column.length > 0);
}
