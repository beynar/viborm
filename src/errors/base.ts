import {
  type DiagnosticDisclosure,
  registerTrustedError,
  sanitizeErrorCause,
  sanitizeErrorMetadata,
  serializeTrustedError,
} from "./diagnostics";

/**
 * Error codes for programmatic error handling
 */
export enum VibORMErrorCode {
  // Connection errors (1xxx)
  CONNECTION_FAILED = "V1001",
  CONNECTION_TIMEOUT = "V1002",
  CONNECTION_CLOSED = "V1003",
  CLIENT_INITIALIZATION = "V1004",

  // Query errors (2xxx)
  QUERY_FAILED = "V2001",
  QUERY_TIMEOUT = "V2002",
  QUERY_SYNTAX = "V2003",

  // Constraint errors (3xxx)
  UNIQUE_CONSTRAINT = "V3001",
  FOREIGN_KEY_CONSTRAINT = "V3002",
  NOT_NULL_CONSTRAINT = "V3003",
  CHECK_CONSTRAINT = "V3004",
  VALUE_TOO_LONG = "V3005",

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
  /** A payload SHAPE the query engine deliberately does not express (a documented
   *  capability boundary), distinct from FEATURE_NOT_SUPPORTED (a dialect/driver
   *  capability gap). Carried by UnsupportedOperationError. */
  UNSUPPORTED_OPERATION = "V8003",

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
  OPERATION_SCOPE_MISMATCH = "V12004",

  // Internal errors (9xxx)
  INTERNAL_ERROR = "V9001",
  SCHEMA_ERROR = "V9002",
}

/**
 * A Prisma error code VibORM is willing to claim.
 *
 * Only codes that appear in {@link PRISMA_CODE_BY_VIBORM_CODE} are listed — the union is the
 * published surface, not the whole Prisma catalogue.
 */
export type PrismaErrorCode =
  | "P1001"
  | "P1002"
  | "P1012"
  | "P1017"
  | "P2000"
  | "P2002"
  | "P2003"
  | "P2004"
  | "P2009"
  | "P2011"
  | "P2025";

/**
 * VibORM code → Prisma code, for `catch` blocks written against Prisma.
 *
 * Prisma surfaces its code as `error.code` on `PrismaClientKnownRequestError` (P2xxx) and as
 * `error.errorCode` on `PrismaClientInitializationError` (P1xxx). VibORM keeps its own stable
 * `V####` taxonomy on `error.code` and publishes the Prisma equivalent next to it as
 * `error.prismaCode`, so `if (e.prismaCode === "P2002")` is the one-token port of
 * `if (e.code === "P2002")`.
 *
 * **The table is deliberately partial.** A VibORM code maps only where Prisma documents a code
 * with the same meaning. Everything else reports `undefined` rather than a near-neighbour: an
 * unclaimed code is honest, a wrong one silently mis-routes a caller's error handling.
 *
 * Sources (checked 2026-07-27):
 * - https://www.prisma.io/docs/orm/reference/error-reference — P1001 "Can't reach database
 *   server", P1002 "…was reached but timed out", P1012 schema validation error, P1017 "Server
 *   has closed the connection", P2000 "The provided value for the column is too long for the
 *   column's type", P2002 "Unique constraint failed on the {constraint}", P2003 "Foreign key
 *   constraint violated on the {constraint}", P2004 "A constraint failed on the database:
 *   {database_error}", P2009 "Failed to validate the query: {query_validation_error}", P2011
 *   "Null constraint violation on the {constraint}", P2025 "An operation failed because it
 *   depends on one or more records that were required but not found".
 * - prisma-engines `libs/user-facing-errors/src/query_engine/mod.rs` pins those codes to the
 *   engine error kinds (`InputValueTooLong` = P2000, `UniqueKeyViolation` = P2002,
 *   `ConstraintViolation` = P2004, `NullConstraintViolation` = P2011, …).
 *
 * Deliberately unmapped (documented refusals, not oversights):
 * - Transaction family (V5xxx). Prisma has P2028 (transaction API) and P2034 (write conflict
 *   or deadlock), but VibORM's transaction family also carries `SQLITE_BUSY` and transaction
 *   timeouts, so no member is 1:1 with either. Use {@link VibORMError.isRetryable} instead.
 * - Nested-write (V7xxx), cache (V10xxx), migration (V11xxx), pending-operation (V12xxx),
 *   feature/driver support (V8xxx incl. `UnsupportedOperationError`) and internal (V9xxx)
 *   codes: VibORM-only concepts with no Prisma counterpart.
 * - Query family (V2xxx). Prisma's P2010 is raw-query-specific and P2021/P2022 name a missing
 *   table/column; a generic `QueryError` is none of those.
 */
const PRISMA_CODE_BY_VIBORM_CODE: ReadonlyMap<
  VibORMErrorCode,
  PrismaErrorCode
> = new Map<VibORMErrorCode, PrismaErrorCode>([
  [VibORMErrorCode.CONNECTION_FAILED, "P1001"],
  [VibORMErrorCode.CONNECTION_TIMEOUT, "P1002"],
  [VibORMErrorCode.CONNECTION_CLOSED, "P1017"],
  [VibORMErrorCode.CLIENT_INITIALIZATION, "P1012"],
  [VibORMErrorCode.UNIQUE_CONSTRAINT, "P2002"],
  [VibORMErrorCode.FOREIGN_KEY_CONSTRAINT, "P2003"],
  [VibORMErrorCode.NOT_NULL_CONSTRAINT, "P2011"],
  [VibORMErrorCode.CHECK_CONSTRAINT, "P2004"],
  [VibORMErrorCode.VALUE_TOO_LONG, "P2000"],
  [VibORMErrorCode.VALIDATION_FAILED, "P2009"],
  [VibORMErrorCode.RECORD_NOT_FOUND, "P2025"],
]);

/**
 * Prisma equivalent of a VibORM error code, or `undefined` when VibORM claims none.
 */
export function toPrismaErrorCode(
  code: VibORMErrorCode
): PrismaErrorCode | undefined {
  return PRISMA_CODE_BY_VIBORM_CODE.get(code);
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
  /** Durable write state known when the error surfaced. */
  commitCertainty?: "committed" | "may-have-committed";
  /** Additional context */
  [key: string]: unknown;
}

/**
 * Base error class for all VibORM errors
 */
export class VibORMError extends Error {
  /** Stable serialized name that survives package minification. */
  static readonly diagnosticName: string = "VibORMError";

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
      diagnostics?: DiagnosticDisclosure | undefined;
    }
  ) {
    super(message);
    const diagnosticName = readDiagnosticName(new.target);
    this.name = diagnosticName;
    this.code = code;
    this.originalCause = options?.cause
      ? sanitizeErrorCause(options.cause)
      : undefined;
    this.meta = sanitizeErrorMetadata(
      options?.meta ?? {},
      options?.diagnostics
    );
    this.timestamp = new Date();
    registerTrustedError(this, {
      cause: this.originalCause,
      code,
      disclosure: options?.diagnostics,
      message,
      meta: this.meta,
      name: diagnosticName,
      prismaCode: toPrismaErrorCode(code),
      timestamp: this.timestamp,
    });

    // Maintain proper stack trace
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * Prisma error code for this error, or `undefined` when VibORM claims no equivalent.
   *
   * Lets a `catch` written for Prisma keep working: `if (error.prismaCode === "P2002")`.
   * See {@link PRISMA_CODE_BY_VIBORM_CODE} for the table and for what is deliberately unmapped.
   */
  get prismaCode(): PrismaErrorCode | undefined {
    return toPrismaErrorCode(this.code);
  }

  /**
   * Check if error is retryable (deadlock, serialization failure)
   *
   * Reads {@link verdictFor}, the one exhaustive switch — so the retryable set cannot drift
   * from the classification, and a new code has to declare its retryability to compile.
   */
  isRetryable(): boolean {
    return verdictFor(this.code).retryable;
  }

  /**
   * Convert to JSON for logging/serialization
   */
  toJSON(): Record<string, unknown> {
    return (
      serializeTrustedError(this) ?? {
        name: "VibORMError",
        message: "VibORM operation failed",
        code: VibORMErrorCode.INTERNAL_ERROR,
        meta: {},
        timestamp: "Invalid Date",
      }
    );
  }
}

function readDiagnosticName(errorConstructor: unknown): string {
  let candidate = errorConstructor;
  for (
    let depth = 0;
    depth < 16 && typeof candidate === "function";
    depth += 1
  ) {
    try {
      const descriptor = Reflect.getOwnPropertyDescriptor(
        candidate,
        "diagnosticName"
      );
      if (
        descriptor &&
        "value" in descriptor &&
        typeof descriptor.value === "string" &&
        descriptor.value.length > 0
      ) {
        return descriptor.value;
      }
      candidate = Object.getPrototypeOf(candidate);
    } catch {
      return "VibORMError";
    }
  }
  return "VibORMError";
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
 * An EXPECTED failure: the database refused, the caller's payload was refused, or a documented
 * capability boundary was reached. Something a caller can be handed and asked to handle.
 */
export interface QueryFailure {
  readonly kind: "failure";
  /** Always a VibORM error — an expected failure is, by definition, one with a taxonomy code. */
  readonly error: VibORMError;
  /** Whether re-running the same operation unchanged could succeed. */
  readonly retryable: boolean;
}

/**
 * A DEFECT: the engine broke its own invariant, or something that is not a VibORM error at all
 * was thrown. Nothing a caller can act on; it means a bug, not a refusal.
 */
export interface EngineDefect {
  readonly kind: "defect";
  readonly error: unknown;
}

/** The per-code verdict. Three module-level constants, so classification allocates nothing. */
interface CodeVerdict {
  readonly expected: boolean;
  readonly retryable: boolean;
}
const EXPECTED: CodeVerdict = { expected: true, retryable: false };
const EXPECTED_RETRYABLE: CodeVerdict = { expected: true, retryable: true };
const DEFECT: CodeVerdict = { expected: false, retryable: false };

/**
 * The taxonomy's disposition, code by code — the ONE place expected-vs-defect and
 * retryable-vs-not are decided, and the reason a missing disposition is now a compile error:
 * the `default` arm binds `code` to `never`, so adding a member to {@link VibORMErrorCode}
 * without giving it a disposition does not build.
 *
 * The rule the arms follow: a code is EXPECTED when something outside the engine said no — the
 * database, the caller's payload, the driver's capabilities, a documented shape boundary. It is
 * a DEFECT only when the engine itself is what went wrong. Retryable is the strictly smaller
 * question: could re-running the identical operation succeed?
 */
function verdictFor(code: VibORMErrorCode): CodeVerdict {
  switch (code) {
    // Connection (1xxx). The server said no, or the client could not be built from the given
    // configuration — all outside the engine. A timeout may clear on its own; a refused or
    // closed connection will not, and a retry loop on it is a hot spin.
    case VibORMErrorCode.CONNECTION_TIMEOUT:
      return EXPECTED_RETRYABLE;
    case VibORMErrorCode.CONNECTION_FAILED:
    case VibORMErrorCode.CONNECTION_CLOSED:
    case VibORMErrorCode.CLIENT_INITIALIZATION:
      return EXPECTED;

    // Query (2xxx). The statement reached the database and came back rejected. A timeout can
    // clear; a rejected statement re-sent unchanged is rejected again.
    case VibORMErrorCode.QUERY_TIMEOUT:
      return EXPECTED_RETRYABLE;
    case VibORMErrorCode.QUERY_FAILED:
    case VibORMErrorCode.QUERY_SYNTAX:
      return EXPECTED;

    // Constraints (3xxx). The schema's own rules, enforced by the database. Never retryable:
    // the data has to change first.
    case VibORMErrorCode.UNIQUE_CONSTRAINT:
    case VibORMErrorCode.FOREIGN_KEY_CONSTRAINT:
    case VibORMErrorCode.NOT_NULL_CONSTRAINT:
    case VibORMErrorCode.CHECK_CONSTRAINT:
    case VibORMErrorCode.VALUE_TOO_LONG:
      return EXPECTED;

    // Validation (4xxx). The caller's payload was refused before any I/O.
    case VibORMErrorCode.VALIDATION_FAILED:
    case VibORMErrorCode.INVALID_INPUT:
    case VibORMErrorCode.MISSING_REQUIRED:
      return EXPECTED;

    // Transaction (5xxx). Deadlock and serialization failure are the two the database itself
    // tells you to re-run — they are the whole reason a retry policy exists. A timeout, a plain
    // failure, and a refused transaction OPTION are not: re-running repeats them.
    case VibORMErrorCode.DEADLOCK:
    case VibORMErrorCode.SERIALIZATION_FAILURE:
      return EXPECTED_RETRYABLE;
    case VibORMErrorCode.TRANSACTION_FAILED:
    case VibORMErrorCode.TRANSACTION_TIMEOUT:
    case VibORMErrorCode.INVALID_TRANSACTION_INPUT:
      return EXPECTED;

    // Not found (6xxx). `…OrThrow` did its job, or the caller named something the schema does
    // not define. Both are answers, not malfunctions.
    case VibORMErrorCode.RECORD_NOT_FOUND:
    case VibORMErrorCode.MODEL_NOT_FOUND:
    case VibORMErrorCode.RELATION_NOT_FOUND:
      return EXPECTED;

    // Nested writes (7xxx). A precondition the caller's tree asserted did not hold — a connect
    // target that vanished, an ownership check that failed. The retry layer above the executor
    // re-runs the SPECIFIC raceable ones by their own marking (`meta.raceable` / a matched
    // `racePin`), never by this flag, which is why none of them is retryable here.
    case VibORMErrorCode.NESTED_WRITE_FAILED:
    case VibORMErrorCode.NESTED_CREATE_FAILED:
    case VibORMErrorCode.NESTED_UPDATE_FAILED:
    case VibORMErrorCode.NESTED_DELETE_FAILED:
    case VibORMErrorCode.NESTED_CONNECT_FAILED:
    case VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED:
      return EXPECTED;

    // Capability (8xxx). THE arm this whole classification exists for. V8003 is carried by
    // `UnsupportedOperationError`, which EXTENDS `QueryEngineError` — so an `instanceof
    // QueryEngineError` check calls a documented shape refusal an engine crash, which is the
    // mistake that surfaced 77 capability refusals as INTERNAL_ERROR for weeks. The code, not
    // the class, decides: V8003 is a refusal, V9001 below is the crash.
    case VibORMErrorCode.FEATURE_NOT_SUPPORTED:
    case VibORMErrorCode.DRIVER_NOT_SUPPORTED:
    case VibORMErrorCode.UNSUPPORTED_OPERATION:
      return EXPECTED;

    // Cache (10xxx). Configuration and cacheability refusals, raised before anything runs.
    case VibORMErrorCode.CACHE_INVALID_TTL:
    case VibORMErrorCode.CACHE_INVALID_KEY:
    case VibORMErrorCode.CACHE_OPERATION_NOT_CACHEABLE:
    case VibORMErrorCode.CACHE_CONFIGURATION:
      return EXPECTED;

    // Migrations (11xxx). Every one of these is a statement about the migration history or the
    // target database, addressed to the operator. A lock failure looks retryable, but the
    // migration runner owns that decision (it needs its own backoff and its own bound), not a
    // generic per-operation retry.
    case VibORMErrorCode.MIGRATION_FAILED:
    case VibORMErrorCode.MIGRATION_NOT_FOUND:
    case VibORMErrorCode.MIGRATION_CHECKSUM_MISMATCH:
    case VibORMErrorCode.MIGRATION_DIALECT_MISMATCH:
    case VibORMErrorCode.MIGRATION_LOCK_FAILED:
    case VibORMErrorCode.MIGRATION_ALREADY_APPLIED:
    case VibORMErrorCode.MIGRATION_OUT_OF_ORDER:
    case VibORMErrorCode.MIGRATION_FILE_NOT_FOUND:
    case VibORMErrorCode.MIGRATION_INVALID_STATE:
    case VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED:
    case VibORMErrorCode.MIGRATION_STORAGE_REQUIRED:
      return EXPECTED;

    // Pending operations (12xxx). Caller misuse of the operation lifecycle — awaiting twice,
    // mixing transaction scopes. A refusal aimed at the person writing the call.
    case VibORMErrorCode.OPERATION_ALREADY_EXECUTED:
    case VibORMErrorCode.OPERATION_EXECUTION_CONFLICT:
    case VibORMErrorCode.OPERATION_CLIENT_MISMATCH:
    case VibORMErrorCode.OPERATION_SCOPE_MISMATCH:
      return EXPECTED;

    // Internal (9xxx). The only two defects in the taxonomy: the engine broke its own
    // invariant, or the schema it was handed is not coherent. Neither is a refusal, and
    // retrying either just repeats the bug.
    case VibORMErrorCode.INTERNAL_ERROR:
    case VibORMErrorCode.SCHEMA_ERROR:
      return DEFECT;

    default: {
      const exhaustive: never = code;
      return exhaustive;
    }
  }
}

/**
 * Classify a surfaced throwable as an expected failure or an engine defect.
 *
 * The one seam the executor and the routed retry policy share. Two rules, both encoded in
 * {@link verdictFor} rather than in `instanceof` chains:
 *
 * - Anything that is not a VibORM error is a DEFECT. A raw throwable escaping the engine means
 *   a path that failed to normalize, not a refusal a caller was meant to receive.
 * - Everything else is decided by its CODE, which is why `UnsupportedOperationError` (V8003)
 *   classifies as a refusal even though it extends `QueryEngineError`, and a bare
 *   `QueryEngineError` (V9001) classifies as a defect even though it is the same class family.
 */
export function classifyFailure(error: unknown): QueryFailure | EngineDefect {
  if (!isVibORMError(error)) {
    return { kind: "defect", error };
  }
  const verdict = verdictFor(error.code);
  if (!verdict.expected) {
    return { kind: "defect", error };
  }
  return { kind: "failure", error, retryable: verdict.retryable };
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
  return new VibORMError("VibORM operation failed", code, { cause, meta });
}
