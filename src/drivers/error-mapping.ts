import {
  attachRecordSeriesProgress,
  CheckConstraintError,
  ClientInitializationError,
  ConnectionError,
  type DiagnosticDisclosure,
  ForeignKeyError,
  getTrustedRecordSeriesProgress,
  isVibORMError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
  NestedWriteAssertionError,
  NotNullConstraintError,
  QueryError,
  TransactionError,
  type TransactionErrorCode,
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
  transferSuppressedFailureEvidence,
} from "./driver-error-context";
import type { Dialect } from "./types";

// Stop at ":" so D1's "users.email: SQLITE_CONSTRAINT" suffix isn't captured
const BUN_SQL_STATE_PATTERN = /^[0-9A-Z]{5}$/;
const PROVIDER_CONNECTION_CODE_PATTERN =
  /^(?:CONNECTION_CLOSED$|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ERR_POSTGRES_CONNECTION_|08[0-9A-Z]{3}$|57P0[123]$)/;
const SQLITE_CONSTRAINT_COLUMNS_PATTERN = /constraint failed: ([^:]+)/;
// Symbolic BUSY/LOCKED codes are the exact base name or an underscore-delimited
// extended family member. The delimiter is load-bearing: startsWith accepted
// unrelated provider codes such as SQLITE_BUSYWORK and SQLITE_LOCKEDNESS.
const SQLITE_CONTENTION_FAMILY_PATTERN =
  /^SQLITE_(?:BUSY|LOCKED)(?:_[A-Z0-9]+)+$/;
const ASCII_PROVIDER_SYMBOL_PATTERN = /[A-Za-z0-9_]+/g;
// An extended result code is `base | (sub << 8)`, so the whole family keeps its
// base in the low byte. That byte alone proves nothing across providers —
// MySQL errno 1029 also ends in 5 — so numeric recognition needs the dialect.
const SQLITE_BASE_CODE_MASK = 0xff;
const SQLITE_BUSY_BASE_CODE = 5;
const SQLITE_LOCKED_BASE_CODE = 6;
const MYSQL_ERRNO_IN_MESSAGE_PATTERN = /\(errno (\d+)\)/;
// Batch-plan assertions (adapter.assertions) fail on purpose with a
// dialect-specific trick: division by zero on PG (SQLSTATE 22012), invalid
// JSON via JSON_EXTRACT/json_extract on MySQL (errno 3141) and SQLite
// ("malformed JSON"). The statements are identifiable by their column alias.
export const ASSERTION_MARKER = "__viborm_assert__";
const POSTGRES_DIVISION_BY_ZERO = "22012";
const MYSQL_INVALID_JSON_TEXT = 3141;

// `json_each(?))` closes a bound member list (SQLite's `literals.list`): JSON
// text the adapter stringified, which cannot raise "malformed JSON".
const JSON_ACCESS_SIGNATURE = /json(?!_each\(\?\)\))|->/i;

const FOREIGN_ASSERTION_SIGNATURE: Record<Dialect, RegExp> = {
  postgresql: /[/%]/,
  mysql: JSON_ACCESS_SIGNATURE,
  sqlite: JSON_ACCESS_SIGNATURE,
};

/**
 * Report whether an ordinary statement can raise the same provider error as a
 * batch assertion. Assertion statements carry {@link ASSERTION_MARKER}; all
 * other statements are checked against the executing dialect's failure
 * signature. With an ownership set, assertions outside that set also collide.
 * A conservative match leaves the raw provider error unattributed.
 */
export function batchMayContainAssertionCollision(
  statements: readonly { readonly sql: string }[],
  dialect: Dialect,
  ownedAssertions?: ReadonlySet<number>
): boolean {
  const signature = FOREIGN_ASSERTION_SIGNATURE[dialect];
  for (const [index, statement] of statements.entries()) {
    if (statement.sql.includes(ASSERTION_MARKER)) {
      if (ownedAssertions && !ownedAssertions.has(index)) return true;
      continue;
    }
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

function isSQLiteContentionResultCode(
  value: string | number | undefined
): boolean {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    return false;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: SQLite defines an extended result code as `base | (sub << 8)`.
  const base = value & SQLITE_BASE_CODE_MASK;
  return base === SQLITE_BUSY_BASE_CODE || base === SQLITE_LOCKED_BASE_CODE;
}

function isSQLiteContentionName(value: string): boolean {
  return (
    value === "SQLITE_BUSY" ||
    value === "SQLITE_LOCKED" ||
    SQLITE_CONTENTION_FAMILY_PATTERN.test(value)
  );
}

/**
 * Report whether a provider error is SQLite lock contention, across the three
 * shapes drivers use: an extended symbolic code, an extended numeric result
 * code, or a message carrying the symbol (D1, libsql).
 */
function isSQLiteContention(
  code: string | number | undefined,
  errno: number | undefined,
  message: string,
  dialect: Dialect | undefined
): boolean {
  if (dialect !== "sqlite") return false;
  if (typeof code === "string" && isSQLiteContentionName(code)) {
    return true;
  }
  if (
    isSQLiteContentionResultCode(code) ||
    isSQLiteContentionResultCode(errno)
  ) {
    return true;
  }
  return [...message.matchAll(ASCII_PROVIDER_SYMBOL_PATTERN)].some((match) =>
    isSQLiteContentionName(match[0])
  );
}

/**
 * A recognized failure's class, called with one options shape. `QueryError`
 * is not one: it is the unrecognized fallback, and its `code` family differs.
 */
type FailureClass = new (
  message: string,
  options: {
    cause: Error;
    code: TransactionErrorCode | undefined;
    diagnostics: DiagnosticDisclosure | undefined;
    meta: VibORMErrorMeta;
  }
) => DriverFailure;

/** What one recognized provider failure becomes: class, message, and code when the class has a family. */
type FailureConstruction = readonly [
  failure: FailureClass,
  message: string,
  code?: TransactionErrorCode | undefined,
  ...rest: unknown[],
];

type ProviderFailure = readonly [
  failure: FailureClass,
  message: string,
  code: TransactionErrorCode | undefined,
  /** PostgreSQL SQLSTATEs and SQLite extended symbolic codes, matched against `code`. */
  providerCodes: readonly unknown[],
  /** MySQL errnos, matched against `errno`. */
  mysqlErrnos: readonly unknown[],
  /** MySQL symbolic names, matched against `code`. */
  mysqlNames: readonly unknown[],
  /** A fragment of the SQLite message that names this failure. */
  sqliteMessage?: string,
  /** Whether that SQLite message lists the failing columns. */
  sqliteColumns?: true,
];

const ASSERTION_FAILURE: FailureConstruction = [
  NestedWriteAssertionError,
  NESTED_WRITE_ASSERTION_FLOOR_MESSAGE,
];
// SQLite lock refusal is contention, not proof of a deadlock.
const SQLITE_CONTENTION_FAILURE: FailureConstruction = [
  TransactionError,
  "Database is locked",
  VibORMErrorCode.TRANSACTION_CONTENTION,
];

/**
 * The recognized provider failures. Precedence is the table read three times:
 * every row's provider code first, then every row's MySQL errno or name, then
 * (after SQLite lock contention) every row's SQLite message fragment. Within a
 * pass, the earlier row wins, so a MySQL errno outranks a later row's name.
 */
const PROVIDER_FAILURES: readonly ProviderFailure[] = [
  [
    UniqueConstraintError,
    "Unique constraint violation",
    undefined,
    ["23505", "SQLITE_CONSTRAINT_UNIQUE"],
    [1062],
    ["ER_DUP_ENTRY"],
    "UNIQUE constraint failed",
    true,
  ],
  [
    ForeignKeyError,
    "Foreign key constraint violation",
    undefined,
    // 23001 is restrict_violation — a RESTRICT referential action refused the
    // write. Stock PostgreSQL folds it into 23503; pg-wire servers (CockroachDB)
    // raise it as its own SQLSTATE with the same foreign-key metadata.
    ["23503", "23001", "SQLITE_CONSTRAINT_FOREIGNKEY"],
    // 1451 is ER_ROW_IS_REFERENCED_2: the parent row is still referenced.
    [1452, 1451],
    ["ER_NO_REFERENCED_ROW_2", "ER_ROW_IS_REFERENCED_2"],
    "FOREIGN KEY constraint failed",
  ],
  [
    NotNullConstraintError,
    "Not-null constraint violation",
    undefined,
    ["23502", "SQLITE_CONSTRAINT_NOTNULL"],
    [1048],
    ["ER_BAD_NULL_ERROR"],
    "NOT NULL constraint failed",
    true,
  ],
  [
    CheckConstraintError,
    "Check constraint violation",
    undefined,
    ["23514", "SQLITE_CONSTRAINT_CHECK"],
    [3819],
    ["ER_CHECK_CONSTRAINT_VIOLATED"],
    "CHECK constraint failed",
  ],
  [
    ValueTooLongError,
    "Value too long for column type",
    undefined,
    // 22001 is string_data_right_truncation and MySQL errno 1406 is
    // ER_DATA_TOO_LONG; Prisma maps both to LengthMismatch/P2000
    // (quaint/src/connector/{postgres,mysql}/error.rs). SQLite has no
    // counterpart: it does not enforce declared column lengths, and quaint's
    // SQLite connector leaves SQLITE_TOOBIG unmapped.
    ["22001"],
    [1406],
    ["ER_DATA_TOO_LONG"],
  ],
  [
    TransactionError,
    "Transaction serialization failure",
    VibORMErrorCode.SERIALIZATION_FAILURE,
    ["40001"],
    [],
    [],
  ],
  [
    TransactionError,
    "Database lock is unavailable",
    VibORMErrorCode.TRANSACTION_CONTENTION,
    ["55P03"],
    [],
    [],
  ],
  [
    TransactionError,
    "Transaction deadlock detected",
    VibORMErrorCode.DEADLOCK,
    ["40P01"],
    [1213],
    ["ER_LOCK_DEADLOCK"],
  ],
];

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
  | ClientInitializationError
  | CheckConstraintError
  | ConnectionError
  | ForeignKeyError
  | NestedWriteAssertionError
  | NotNullConstraintError
  | QueryError
  | TransactionError
  | UniqueConstraintError
  | ValueTooLongError;

function isConfigurationFailure(
  code: string | number | undefined,
  errno?: number
): boolean {
  return (
    [
      "28P01",
      "28000",
      "3D000",
      "ER_ACCESS_DENIED_ERROR",
      "ER_BAD_DB_ERROR",
    ].includes(String(code)) ||
    errno === 1045 ||
    errno === 1049
  );
}

function isConnectionCapacityFailure(
  code: string | number | undefined,
  errno?: number
): boolean {
  return (
    code === "53300" ||
    code === "ER_CON_COUNT_ERROR" ||
    code === "ER_TOO_MANY_USER_CONNECTIONS" ||
    errno === 1040 ||
    errno === 1203
  );
}

function configurationFailure(
  cause: Error,
  context: DriverErrorContext,
  meta: VibORMErrorMeta
): ClientInitializationError {
  return new ClientInitializationError(
    "Database authentication or configuration failed",
    { cause, meta, diagnostics: context.diagnostics }
  );
}

function withProviderFailureEvidence<T extends DriverFailure>(
  error: unknown,
  failure: T
): T {
  transferSuppressedFailureEvidence(error, failure);
  return failure;
}

/**
 * What {@link normalizeDriverError} can hand back.
 *
 * Two arms, and the type is the union of both. A raw provider error is mapped to a
 * {@link DriverFailure}. An error that is ALREADY a VibORM error is passed through with
 * execution context attached — and that arm is honestly `VibORMError`, not `DriverFailure`:
 * the incoming error can be any VibORM error the layers above threw (a `ValidationError`, an
 * engine refusal), `attachExecutionContext` clones it under its own class, and a stateful
 * class it cannot rebuild degrades to the base `VibORMError` (`driver-error-context.ts`).
 * Typing the whole function `DriverFailure` would be a claim this arm cannot keep.
 */
export type NormalizedDriverError = DriverFailure | VibORMError;

export function normalizeDriverError(
  error: unknown,
  context: DriverErrorContext
): NormalizedDriverError {
  if (isKnownVibORMError(error)) {
    const normalized = attachExecutionContext(error, context);
    const progress = getTrustedRecordSeriesProgress(error);
    return progress
      ? attachRecordSeriesProgress(normalized, progress)
      : normalized;
  }
  return mapProviderError(error, context);
}

/**
 * Map a raw provider error onto the {@link DriverFailure} vocabulary. Split out of
 * {@link normalizeDriverError} so the constructed union has a return type to be checked
 * against — the passthrough arm above cannot carry that annotation, and a function has one
 * return type. {@link recognizeProviderFailure} decides which failure it is; this is the
 * one place it is constructed.
 */
function mapProviderError(
  error: unknown,
  context: DriverErrorContext
): DriverFailure {
  const cause = toError(error);
  const rawMessage = getErrorMessage(cause);
  const dbError = readDriverErrorShape(error);
  const meta = buildMeta(dbError, context, rawMessage);
  const stringErrno = dbError.stringErrno;
  const bunSqlState =
    context.driverName === "bun-sql" &&
    typeof dbError.code === "string" &&
    dbError.code.startsWith("ERR_POSTGRES") &&
    BUN_SQL_STATE_PATTERN.test(stringErrno ?? "")
      ? stringErrno
      : undefined;
  const code = bunSqlState ?? dbError.sqlstate ?? dbError.code;
  if (bunSqlState) meta.providerCode = bunSqlState;
  if (isConfigurationFailure(code, dbError.errno))
    return withProviderFailureEvidence(
      error,
      configurationFailure(cause, context, meta)
    );
  if (typeof code === "string" && PROVIDER_CONNECTION_CODE_PATTERN.test(code)) {
    return withProviderFailureEvidence(
      error,
      new ConnectionError("Database connection failed", {
        cause,
        diagnostics: context.diagnostics,
        meta,
        code:
          code === "ETIMEDOUT"
            ? VibORMErrorCode.CONNECTION_TIMEOUT
            : VibORMErrorCode.CONNECTION_FAILED,
      })
    );
  }
  const errno = dbError.errno ?? parseMessageErrno(rawMessage);
  if (errno !== undefined && meta.providerErrno === undefined) {
    meta.providerErrno = errno;
  }

  const diagnostics = context.diagnostics;
  // SQLSTATEs and MySQL constants name the physical failure, independently of
  // localized provider text. SQLite exposes these categories only in messages.
  const capacity = isConnectionCapacityFailure(code, errno);
  const schemaMismatch =
    code === "42P01" ||
    code === "42703" ||
    code === "ER_NO_SUCH_TABLE" ||
    code === "ER_BAD_FIELD_ERROR" ||
    errno === 1146 ||
    errno === 1054 ||
    (context.dialect === "sqlite" &&
      (rawMessage.includes("no such table:") ||
        rawMessage.includes("no such column:") ||
        rawMessage.includes("has no column named")));
  const outOfRange =
    code === "22003" ||
    code === "ER_WARN_DATA_OUT_OF_RANGE" ||
    code === "ER_DATA_OUT_OF_RANGE" ||
    errno === 1264 ||
    errno === 1690 ||
    (context.dialect === "sqlite" && rawMessage.includes("integer overflow"));
  if (capacity || schemaMismatch || outOfRange)
    return withProviderFailureEvidence(
      error,
      capacity
        ? new ConnectionError("Database connection capacity exhausted", {
            cause,
            diagnostics,
            meta,
            code: VibORMErrorCode.CONNECTION_CAPACITY,
          })
        : new QueryError(
            schemaMismatch
              ? "Database table or column does not exist"
              : "Value exceeds the database numeric range",
            {
              cause,
              diagnostics,
              meta,
              code: schemaMismatch
                ? VibORMErrorCode.QUERY_SCHEMA_MISMATCH
                : VibORMErrorCode.QUERY_OUT_OF_RANGE,
            }
          )
    );
  if (code === "57014" || code === "ER_LOCK_WAIT_TIMEOUT" || errno === 1205) {
    return withProviderFailureEvidence(
      error,
      new QueryError("Query timed out", {
        cause,
        diagnostics,
        meta,
        code: VibORMErrorCode.QUERY_TIMEOUT,
      })
    );
  }
  const recognized = recognizeProviderFailure(
    code,
    errno,
    rawMessage,
    meta,
    context
  );
  let failure: DriverFailure;
  if (recognized) {
    const [Failure, message, failureCode] = recognized;
    failure = new Failure(message, {
      cause,
      code: failureCode,
      diagnostics,
      meta,
    });
  } else {
    failure = new QueryError("Query execution failed", {
      cause,
      diagnostics,
      meta,
    });
  }
  transferSuppressedFailureEvidence(error, failure);
  return failure;
}

/**
 * Which failure a raw provider error is. An assertion statement's own failure
 * comes first; then {@link PROVIDER_FAILURES} in its three passes, with SQLite
 * lock contention before the SQLite message pass. Anything else is not
 * recognized.
 */
function recognizeProviderFailure(
  code: string | number | undefined,
  errno: number | undefined,
  message: string,
  meta: VibORMErrorMeta,
  context: DriverErrorContext
): FailureConstruction | undefined {
  if (
    context.query?.includes(ASSERTION_MARKER) &&
    isAssertionFailure(code, errno, message)
  ) {
    return ASSERTION_FAILURE;
  }
  const recognized =
    PROVIDER_FAILURES.find((row) => row[3].includes(code)) ??
    PROVIDER_FAILURES.find(
      (row) => row[4].includes(errno) || row[5].includes(code)
    );
  if (recognized) {
    if (recognized[7] && typeof code === "string" && code.startsWith("SQLITE_"))
      attachSQLiteColumns(message, meta);
    return recognized;
  }
  if (isSQLiteContention(code, errno, message, context.dialect)) {
    return SQLITE_CONTENTION_FAILURE;
  }
  return findSQLiteMessageFailure(message, meta);
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
  const code = dbError.sqlstate ?? dbError.code;
  if (isConfigurationFailure(code, errno))
    return withProviderFailureEvidence(
      error,
      configurationFailure(cause, context, meta)
    );
  return withProviderFailureEvidence(
    error,
    new ConnectionError(
      isConnectionCapacityFailure(code, errno)
        ? "Database connection capacity exhausted"
        : message,
      {
        cause,
        diagnostics: context.diagnostics,
        meta,
        code: isConnectionCapacityFailure(code, errno)
          ? VibORMErrorCode.CONNECTION_CAPACITY
          : code === "ETIMEDOUT"
            ? VibORMErrorCode.CONNECTION_TIMEOUT
            : VibORMErrorCode.CONNECTION_FAILED,
      }
    )
  );
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
  const errno = readProperty(error, "errno");
  return {
    code: readStringOrNumber(error, "code"),
    bodyCode:
      body && (typeof body === "object" || typeof body === "function")
        ? readStringOrNumber(body, "code")
        : undefined,
    errno: typeof errno === "number" ? errno : undefined,
    stringErrno: typeof errno === "string" ? errno : undefined,
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

/**
 * The first row whose SQLite message fragment the provider message carries, in
 * table order. UNIQUE and NOT NULL messages also name their columns.
 */
function findSQLiteMessageFailure(
  message: string,
  meta: VibORMErrorMeta
): ProviderFailure | undefined {
  const row = PROVIDER_FAILURES.find(
    (candidate) => candidate[6] && message.includes(candidate[6])
  );
  if (row?.[7]) attachSQLiteColumns(message, meta);
  return row;
}

function attachSQLiteColumns(message: string, meta: VibORMErrorMeta): void {
  const match = SQLITE_CONSTRAINT_COLUMNS_PATTERN.exec(message);
  if (!match?.[1]) return;
  // Accept only an unambiguous identifier list. Quoted dots/commas are leaves,
  // not separators; arbitrary constraint expressions never become column names.
  const identifier = String.raw`(?:"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_$]*)`;
  const path = `${identifier}(?:\\s*\\.\\s*${identifier})*`;
  if (!new RegExp(`^\\s*${path}(?:\\s*,\\s*${path})*\\s*$`).test(match[1]))
    return;
  const paths = match[1].match(new RegExp(path, "g"));
  if (!paths) return;
  const columns: string[] = [];
  const tables = new Set<string>();
  for (const qualified of paths) {
    const parts = qualified.match(new RegExp(identifier, "g"));
    if (!parts?.length) return;
    const names = parts.map((part) => {
      if (part.startsWith('"')) return part.slice(1, -1).replaceAll('""', '"');
      if (part.startsWith("`")) return part.slice(1, -1).replaceAll("``", "`");
      if (part.startsWith("[")) return part.slice(1, -1);
      return part;
    });
    const column = names.pop();
    if (column === undefined) return;
    columns.push(column);
    if (names.length) tables.add(names.join("."));
  }
  meta.columns = columns;
  if (tables.size === 1) meta.table = tables.values().next().value;
}
