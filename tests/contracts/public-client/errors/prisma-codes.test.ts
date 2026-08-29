/**
 * Prisma error-code compatibility (`error.prismaCode`).
 *
 * A `catch` written against Prisma switches on `error.code` (P2xxx on
 * `PrismaClientKnownRequestError`) or `error.errorCode` (P1xxx on
 * `PrismaClientInitializationError`). VibORM keeps its own `V####` taxonomy and publishes the
 * Prisma equivalent alongside it, so porting a handler is a one-token edit.
 *
 * These tests pin BOTH directions: the codes VibORM claims, and the codes it deliberately
 * refuses to claim. The exhaustiveness test is the tripwire — a new `VibORMErrorCode` fails
 * here until someone decides, in writing, whether Prisma has an equivalent.
 */

import {
  CacheInvalidTTLError,
  CheckConstraintError,
  ClientInitializationError,
  ConnectionError,
  ForeignKeyError,
  InvalidTransactionInputError,
  isVibORMError,
  MigrationError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryError,
  registerTrustedError,
  serializeTrustedError,
  TransactionError,
  toPrismaErrorCode,
  UniqueConstraintError,
  ValidationError,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { UnsupportedOperationError } from "@src/query-engine/write-engine/shared";

/**
 * The published table. Each row is a class a caller actually catches, so the test exercises
 * the real constructor rather than the map in isolation.
 */
const CLAIMED: Array<{
  prismaCode: string;
  vibormCode: VibORMErrorCode;
  error: VibORMError;
}> = [
  {
    prismaCode: "P2002",
    vibormCode: VibORMErrorCode.UNIQUE_CONSTRAINT,
    error: new UniqueConstraintError("Unique constraint violation"),
  },
  {
    prismaCode: "P2003",
    vibormCode: VibORMErrorCode.FOREIGN_KEY_CONSTRAINT,
    error: new ForeignKeyError("Foreign key constraint violation"),
  },
  {
    prismaCode: "P2011",
    vibormCode: VibORMErrorCode.NOT_NULL_CONSTRAINT,
    error: new NotNullConstraintError("Not-null constraint violation"),
  },
  {
    prismaCode: "P2004",
    vibormCode: VibORMErrorCode.CHECK_CONSTRAINT,
    error: new CheckConstraintError("Check constraint violation"),
  },
  {
    prismaCode: "P2000",
    vibormCode: VibORMErrorCode.VALUE_TOO_LONG,
    error: new ValueTooLongError("Value too long for column type"),
  },
  {
    prismaCode: "P2025",
    vibormCode: VibORMErrorCode.RECORD_NOT_FOUND,
    error: new NotFoundError("user", "findUniqueOrThrow"),
  },
  {
    prismaCode: "P2009",
    vibormCode: VibORMErrorCode.VALIDATION_FAILED,
    error: new ValidationError("create", [
      { message: "id is required", path: "data.id" },
    ]),
  },
  {
    prismaCode: "P1001",
    vibormCode: VibORMErrorCode.CONNECTION_FAILED,
    error: new ConnectionError("Database connection failed"),
  },
  {
    prismaCode: "P1002",
    vibormCode: VibORMErrorCode.CONNECTION_TIMEOUT,
    error: new ConnectionError("Connection timed out", {
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
    }),
  },
  {
    prismaCode: "P1017",
    vibormCode: VibORMErrorCode.CONNECTION_CLOSED,
    error: new ConnectionError("Driver is closed", {
      code: VibORMErrorCode.CONNECTION_CLOSED,
    }),
  },
  {
    prismaCode: "P1012",
    vibormCode: VibORMErrorCode.CLIENT_INITIALIZATION,
    error: new ClientInitializationError('Model "ghost" not found in schema'),
  },
];

/**
 * VibORM-only failures. `undefined` is the honest answer — a near-neighbour Prisma code would
 * silently re-route a caller's error handling.
 */
const UNCLAIMED: Array<{ label: string; error: VibORMError }> = [
  { label: "QueryError", error: new QueryError("Query execution failed") },
  {
    label: "TransactionError",
    error: new TransactionError("Transaction deadlock detected", {
      code: VibORMErrorCode.DEADLOCK,
    }),
  },
  {
    label: "InvalidTransactionInputError",
    error: new InvalidTransactionInputError(),
  },
  {
    label: "NestedWriteError",
    error: new NestedWriteError("Nested write failed", "posts"),
  },
  {
    label: "CacheInvalidTTLError",
    error: new CacheInvalidTTLError("Invalid TTL"),
  },
  {
    label: "MigrationError",
    error: new MigrationError(
      "Migration failed",
      VibORMErrorCode.MIGRATION_FAILED
    ),
  },
  {
    label: "PendingOperationError",
    error: PendingOperationError.clientMismatch("user", "create"),
  },
  {
    label: "UnsupportedOperationError",
    error: new UnsupportedOperationError("Shape outside the supported family"),
  },
];

/**
 * Every code with no Prisma equivalent, spelled out. Adding a `VibORMErrorCode` without
 * deciding its Prisma disposition fails the exhaustiveness test below.
 */
const EXPECTED_UNMAPPED: VibORMErrorCode[] = [
  VibORMErrorCode.QUERY_FAILED,
  VibORMErrorCode.QUERY_TIMEOUT,
  VibORMErrorCode.QUERY_SYNTAX,
  VibORMErrorCode.INVALID_INPUT,
  VibORMErrorCode.MISSING_REQUIRED,
  VibORMErrorCode.TRANSACTION_FAILED,
  VibORMErrorCode.TRANSACTION_TIMEOUT,
  VibORMErrorCode.DEADLOCK,
  VibORMErrorCode.SERIALIZATION_FAILURE,
  VibORMErrorCode.INVALID_TRANSACTION_INPUT,
  VibORMErrorCode.MODEL_NOT_FOUND,
  VibORMErrorCode.RELATION_NOT_FOUND,
  VibORMErrorCode.NESTED_WRITE_FAILED,
  VibORMErrorCode.NESTED_CREATE_FAILED,
  VibORMErrorCode.NESTED_UPDATE_FAILED,
  VibORMErrorCode.NESTED_DELETE_FAILED,
  VibORMErrorCode.NESTED_CONNECT_FAILED,
  VibORMErrorCode.NESTED_WRITE_ASSERTION_FAILED,
  VibORMErrorCode.FEATURE_NOT_SUPPORTED,
  VibORMErrorCode.DRIVER_NOT_SUPPORTED,
  // V8003 is viborm's portability refusal — "this driver cannot honor what you
  // asked, and here is why". Prisma has no user-facing equivalent: it either
  // supports a thing on a provider or the method does not exist there, so there
  // is no P-code to claim. Deliberately unclaimed.
  VibORMErrorCode.UNSUPPORTED_OPERATION,
  VibORMErrorCode.CACHE_INVALID_TTL,
  VibORMErrorCode.CACHE_INVALID_KEY,
  VibORMErrorCode.CACHE_OPERATION_NOT_CACHEABLE,
  VibORMErrorCode.CACHE_CONFIGURATION,
  VibORMErrorCode.MIGRATION_FAILED,
  VibORMErrorCode.MIGRATION_NOT_FOUND,
  VibORMErrorCode.MIGRATION_CHECKSUM_MISMATCH,
  VibORMErrorCode.MIGRATION_DIALECT_MISMATCH,
  VibORMErrorCode.MIGRATION_LOCK_FAILED,
  VibORMErrorCode.MIGRATION_ALREADY_APPLIED,
  VibORMErrorCode.MIGRATION_OUT_OF_ORDER,
  VibORMErrorCode.MIGRATION_FILE_NOT_FOUND,
  VibORMErrorCode.MIGRATION_INVALID_STATE,
  VibORMErrorCode.MIGRATION_DESTRUCTIVE_REJECTED,
  VibORMErrorCode.MIGRATION_STORAGE_REQUIRED,
  VibORMErrorCode.MIGRATION_INVALID_ESTATE,
  VibORMErrorCode.MIGRATION_PATH_REQUIRED,
  VibORMErrorCode.MIGRATION_DRIFT,
  VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
  VibORMErrorCode.MIGRATION_UNFINISHED_ATTEMPT,
  VibORMErrorCode.MIGRATION_CONSENT_REQUIRED,
  VibORMErrorCode.MIGRATION_CONSENT_MISMATCH,
  VibORMErrorCode.MIGRATION_PARTIAL_EFFECT,
  VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
  VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
  VibORMErrorCode.MIGRATION_CORRUPTION,
  VibORMErrorCode.OPERATION_ALREADY_EXECUTED,
  VibORMErrorCode.OPERATION_EXECUTION_CONFLICT,
  VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
  VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
  VibORMErrorCode.INTERNAL_ERROR,
  VibORMErrorCode.SCHEMA_ERROR,
];

describe("prismaCode taxonomy", () => {
  test.each(CLAIMED)("$vibormCode publishes $prismaCode", (row) => {
    expect(row.error.code).toBe(row.vibormCode);
    expect(row.error.prismaCode).toBe(row.prismaCode);
    expect(toPrismaErrorCode(row.vibormCode)).toBe(row.prismaCode);
  });

  test.each(UNCLAIMED)("$label claims no Prisma code", (row) => {
    expect(row.error.prismaCode).toBeUndefined();
  });

  test("every error code is either claimed or documented as unclaimed", () => {
    const claimed = new Set(CLAIMED.map((row) => row.vibormCode));
    const unmapped = new Set(EXPECTED_UNMAPPED);

    const unclassified = Object.values(VibORMErrorCode).filter(
      (code) => !(claimed.has(code) || unmapped.has(code))
    );
    expect(unclassified).toEqual([]);

    // And the two lists agree with the runtime table in both directions.
    for (const code of Object.values(VibORMErrorCode)) {
      const mapped = toPrismaErrorCode(code);
      if (claimed.has(code)) {
        expect(mapped).toBeDefined();
      } else {
        expect(mapped).toBeUndefined();
      }
    }
  });

  test("instanceof and code surfaces are unchanged", () => {
    const unique = new UniqueConstraintError("Unique constraint violation");
    expect(unique).toBeInstanceOf(UniqueConstraintError);
    expect(unique).toBeInstanceOf(VibORMError);
    expect(unique).toBeInstanceOf(Error);
    expect(isVibORMError(unique)).toBe(true);
    expect(unique.code).toBe(VibORMErrorCode.UNIQUE_CONSTRAINT);
    expect(unique.name).toBe("UniqueConstraintError");

    const init = new ClientInitializationError("Driver is required");
    expect(init).toBeInstanceOf(ClientInitializationError);
    expect(init).toBeInstanceOf(VibORMError);
    expect(init.name).toBe("ClientInitializationError");
  });
});

describe("prismaCode serialization", () => {
  test("toJSON carries prismaCode next to code when one is claimed", () => {
    const error = new UniqueConstraintError("Unique constraint violation", {
      meta: { model: "user", operation: "create" },
    });

    const json = error.toJSON();

    expect(json).toMatchObject({
      name: "UniqueConstraintError",
      code: "V3001",
      prismaCode: "P2002",
    });
    expect(JSON.parse(JSON.stringify(error)).prismaCode).toBe("P2002");
  });

  test("toJSON omits prismaCode entirely when none is claimed", () => {
    const json = new QueryError("Query execution failed").toJSON();

    expect(json.code).toBe("V2001");
    expect("prismaCode" in json).toBe(false);
  });

  test("a non-Prisma-shaped code is dropped rather than echoed", () => {
    // The trusted-snapshot registrar is the only writer of this field; it must not pass
    // through anything that is not P + four digits.
    const forged = new Error("forged");
    registerTrustedError(forged, {
      code: "V9001",
      message: "forged",
      meta: {},
      name: "Error",
      prismaCode: "javascript:alert(1)",
      timestamp: new Date(),
    });

    const serialized = serializeTrustedError(forged);

    expect(serialized).toBeDefined();
    expect(serialized && "prismaCode" in serialized).toBe(false);
  });
});
