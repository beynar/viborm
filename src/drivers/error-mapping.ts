import {
  CheckConstraintError,
  ForeignKeyError,
  isVibORMError,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
  type VibORMErrorMeta,
} from "@errors";
import type { Operation } from "@query-engine/types";

interface DriverErrorShape {
  code?: string | number;
  errno?: number;
  constraint?: string;
  table?: string;
  column?: string;
  // postgres.js (porsager) exposes the same fields with _name suffixes
  constraint_name?: string;
  table_name?: string;
  column_name?: string;
  detail?: string;
  message?: string;
}

interface DriverErrorContext {
  driverName: string;
  model?: string;
  operation?: Operation;
  query?: string;
  params?: unknown[];
}

const POSTGRES_UNIQUE = "23505";
const POSTGRES_FOREIGN_KEY = "23503";
const POSTGRES_NOT_NULL = "23502";
const POSTGRES_CHECK = "23514";
const POSTGRES_SERIALIZATION = "40001";
const POSTGRES_DEADLOCK = "40P01";

const MYSQL_UNIQUE = 1062;
const MYSQL_FOREIGN_KEY = 1452;
const MYSQL_FOREIGN_KEY_ROW_IS_REFERENCED = 1451;
const MYSQL_NOT_NULL = 1048;
const MYSQL_CHECK = 3819;
const MYSQL_DEADLOCK = 1213;
const MYSQL_LOCK_WAIT_TIMEOUT = 1205;
// Stop at ":" so D1's "users.email: SQLITE_CONSTRAINT" suffix isn't captured
const SQLITE_CONSTRAINT_COLUMNS_PATTERN = /constraint failed: ([^:]+)/;
// PlanetScale (Vitess) buries the MySQL errno in the message text
const MYSQL_ERRNO_IN_MESSAGE_PATTERN = /\(errno (\d+)\)/;
const MYSQL_KEY_IN_MESSAGE_PATTERN = /for key '([^']+)'/;

// Batch-plan assertions (adapter.assertions) fail on purpose with a
// dialect-specific trick: division by zero on PG (SQLSTATE 22012), invalid
// JSON via JSON_EXTRACT/json_extract on MySQL (errno 3141) and SQLite
// ("malformed JSON"). The statements are identifiable by their column alias.
const ASSERTION_MARKER = "__viborm_assert__";
const POSTGRES_DIVISION_BY_ZERO = "22012";
const MYSQL_INVALID_JSON_TEXT = 3141;

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

export function normalizeDriverError(
  error: unknown,
  context: DriverErrorContext
): Error {
  if (isVibORMError(error)) {
    return error;
  }

  const cause = error instanceof Error ? error : new Error(String(error));
  const dbError = error as DriverErrorShape;
  const meta = buildMeta(dbError, context, cause.message);
  const code = dbError.code;
  const errno = dbError.errno ?? parseMessageErrno(cause.message);

  if (
    context.query?.includes(ASSERTION_MARKER) &&
    isAssertionFailure(code, errno, cause.message)
  ) {
    return new NestedWriteAssertionError(
      "Nested write assertion failed: a batch precondition (e.g. a connect/disconnect target or ownership check) did not hold.",
      { cause, meta }
    );
  }

  if (code === POSTGRES_UNIQUE || code === "SQLITE_CONSTRAINT_UNIQUE") {
    return new UniqueConstraintError("Unique constraint violation", {
      cause,
      meta,
    });
  }

  if (
    code === POSTGRES_FOREIGN_KEY ||
    code === "SQLITE_CONSTRAINT_FOREIGNKEY"
  ) {
    return new ForeignKeyError("Foreign key constraint violation", {
      cause,
      meta,
    });
  }

  if (code === POSTGRES_NOT_NULL || code === "SQLITE_CONSTRAINT_NOTNULL") {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      meta,
    });
  }

  if (code === POSTGRES_CHECK || code === "SQLITE_CONSTRAINT_CHECK") {
    return new CheckConstraintError("Check constraint violation", {
      cause,
      meta,
    });
  }

  if (code === POSTGRES_SERIALIZATION) {
    return new TransactionError("Transaction serialization failure", {
      cause,
      meta,
      code: VibORMErrorCode.SERIALIZATION_FAILURE,
    });
  }

  if (code === POSTGRES_DEADLOCK) {
    return new TransactionError("Transaction deadlock detected", {
      cause,
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  if (errno === MYSQL_UNIQUE || code === "ER_DUP_ENTRY") {
    return new UniqueConstraintError("Unique constraint violation", {
      cause,
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
      meta,
    });
  }

  if (errno === MYSQL_NOT_NULL || code === "ER_BAD_NULL_ERROR") {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      meta,
    });
  }

  if (errno === MYSQL_CHECK || code === "ER_CHECK_CONSTRAINT_VIOLATED") {
    return new CheckConstraintError("Check constraint violation", {
      cause,
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
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  if (
    code === "SQLITE_BUSY" ||
    code === "SQLITE_LOCKED" ||
    cause.message.includes("SQLITE_BUSY") ||
    cause.message.includes("SQLITE_LOCKED")
  ) {
    // DEADLOCK code so the write-race retry logic treats it as retryable
    return new TransactionError("Database is locked", {
      cause,
      meta,
      code: VibORMErrorCode.DEADLOCK,
    });
  }

  const sqliteConstraint = mapSQLiteConstraint(cause.message, meta, cause);
  if (sqliteConstraint) {
    return sqliteConstraint;
  }

  return new QueryError(cause.message, { cause, meta });
}

function parseMessageErrno(message: string): number | undefined {
  const match = MYSQL_ERRNO_IN_MESSAGE_PATTERN.exec(message);
  return match?.[1] ? Number(match[1]) : undefined;
}

function buildMeta(
  error: DriverErrorShape,
  context: DriverErrorContext,
  message: string
): VibORMErrorMeta {
  const meta: VibORMErrorMeta = {
    driver: context.driverName,
  };

  if (context.model) meta.model = context.model;
  if (context.operation) meta.operation = context.operation;
  if (context.query) meta.query = context.query;
  if (context.params) meta.params = context.params;

  const constraint = error.constraint ?? error.constraint_name;
  const table = error.table ?? error.table_name;
  const column = error.column ?? error.column_name;
  if (constraint) meta.constraint = constraint;
  if (table) meta.table = table;
  if (column) meta.columns = [column];

  // MySQL reports the violated key only in the message: "for key 'users.email_key'"
  if (!meta.constraint) {
    const key = MYSQL_KEY_IN_MESSAGE_PATTERN.exec(message)?.[1];
    if (key) {
      const dotIndex = key.indexOf(".");
      if (dotIndex === -1) {
        meta.constraint = key;
      } else {
        meta.constraint = key.slice(dotIndex + 1);
        if (!meta.table) meta.table = key.slice(0, dotIndex);
      }
    }
  }

  return meta;
}

function mapSQLiteConstraint(
  message: string,
  meta: VibORMErrorMeta,
  cause: Error
): Error | undefined {
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
      meta: { ...meta, columns: parseSQLiteColumns(message) },
    });
  }

  if (message.includes("FOREIGN KEY constraint failed")) {
    return new ForeignKeyError("Foreign key constraint violation", {
      cause,
      meta,
    });
  }

  if (message.includes("NOT NULL constraint failed")) {
    return new NotNullConstraintError("Not-null constraint violation", {
      cause,
      meta: { ...meta, columns: parseSQLiteColumns(message) },
    });
  }

  if (message.includes("CHECK constraint failed")) {
    return new CheckConstraintError("Check constraint violation", {
      cause,
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
