import {
  CacheConfigurationError,
  CacheInvalidKeyError,
  CacheInvalidTTLError,
  CacheOperationNotCacheableError,
  CheckConstraintError,
  ClientInitializationError,
  ForeignKeyError,
  hasErrorCode,
  InvalidTransactionInputError,
  isCheckConstraintError,
  isClientInitializationError,
  isForeignKeyError,
  isMigrationError,
  isNotFoundError,
  isNotNullConstraintError,
  isPendingOperationError,
  isRetryableError,
  isUniqueConstraintError,
  isUnsupportedOperationError,
  isValidationError,
  isValueTooLongError,
  MigrationError,
  NestedWriteError,
  NotFoundError,
  NotNullConstraintError,
  PendingOperationError,
  QueryError,
  TransactionError,
  UniqueConstraintError,
  UnsupportedOperationError,
  unsupportedVector,
  ValidationError,
  ValueTooLongError,
  type VibORMError,
  VibORMErrorCode,
  wrapError,
} from "@errors";
import { expectTypeOf } from "vitest";

describe("public error helpers", () => {
  it("narrows VibORM errors by their stable code", () => {
    const error: unknown = new UniqueConstraintError("duplicate");

    if (!hasErrorCode(error, VibORMErrorCode.UNIQUE_CONSTRAINT)) {
      throw new Error("expected the code guard to match");
    }

    expectTypeOf(error).toEqualTypeOf<VibORMError>();
    expect(hasErrorCode(error, VibORMErrorCode.FOREIGN_KEY_CONSTRAINT)).toBe(
      false
    );
    expect(hasErrorCode(new Error("foreign"), error.code)).toBe(false);
  });

  it("recognizes every exported class-specific guard", () => {
    const unique = new UniqueConstraintError("unique");
    const foreignKey = new ForeignKeyError("foreign key");
    const notNull = new NotNullConstraintError("not null");
    const check = new CheckConstraintError("check");
    const tooLong = new ValueTooLongError("too long");
    const migration = new MigrationError("migration");
    const notFound = new NotFoundError("user", "findUniqueOrThrow");
    const pending = PendingOperationError.clientMismatch("user", "findMany");
    const unsupported = new UnsupportedOperationError("unsupported shape");
    const validation = new ValidationError("create", [
      { path: "data.id", message: "required" },
    ]);
    const initialization = new ClientInitializationError("missing driver");

    expect(isUniqueConstraintError(unique)).toBe(true);
    expect(isForeignKeyError(foreignKey)).toBe(true);
    expect(isNotNullConstraintError(notNull)).toBe(true);
    expect(isCheckConstraintError(check)).toBe(true);
    expect(isValueTooLongError(tooLong)).toBe(true);
    expect(isMigrationError(migration)).toBe(true);
    expect(isNotFoundError(notFound)).toBe(true);
    expect(isPendingOperationError(pending)).toBe(true);
    expect(isUnsupportedOperationError(unsupported)).toBe(true);
    expect(isValidationError(validation)).toBe(true);
    expect(isClientInitializationError(initialization)).toBe(true);

    for (const guard of [
      isUniqueConstraintError,
      isForeignKeyError,
      isNotNullConstraintError,
      isCheckConstraintError,
      isValueTooLongError,
      isMigrationError,
      isNotFoundError,
      isPendingOperationError,
      isUnsupportedOperationError,
      isValidationError,
      isClientInitializationError,
    ]) {
      expect(guard(new Error("other"))).toBe(false);
    }
  });

  it("recognizes retryable provider errors without accepting lookalikes", () => {
    for (const code of ["40001", "40P01", "SQLITE_BUSY"]) {
      expect(
        isRetryableError(Object.assign(new Error("retry"), { code }))
      ).toBe(true);
    }

    expect(
      isRetryableError(
        Object.assign(new Error("not retryable"), { code: 40_001 })
      )
    ).toBe(false);
    expect(isRetryableError({ code: "40001" })).toBe(false);
    expect(isRetryableError(new Error("no code"))).toBe(false);
  });

  it("wraps foreign throwables once and preserves VibORM errors", () => {
    const existing = new QueryError("query failed");
    expect(wrapError(existing)).toBe(existing);

    const wrappedError = wrapError(
      new Error("provider failed"),
      VibORMErrorCode.QUERY_FAILED,
      { operation: "findMany" }
    );
    expect(wrappedError).toMatchObject({
      code: VibORMErrorCode.QUERY_FAILED,
      meta: { operation: "findMany" },
    });
    expect(wrappedError.originalCause).toBeInstanceOf(Error);

    const wrappedValue = wrapError("thrown string");
    expect(wrappedValue.code).toBe(VibORMErrorCode.INTERNAL_ERROR);
    expect(wrappedValue.originalCause).toBeInstanceOf(Error);
  });
});

describe("concrete error contracts", () => {
  it("keeps cache messages, metadata, and causes", () => {
    expect(
      new CacheInvalidTTLError("bad ttl", { meta: { timeout: 4 } }).meta
    ).toEqual({ timeout: 4 });
    expect(
      new CacheInvalidKeyError("bad key", { meta: { operation: "read" } }).meta
    ).toEqual({ operation: "read" });

    const notCacheable = new CacheOperationNotCacheableError(
      "create",
      ["findMany", "findUnique"],
      { meta: { model: "user" } }
    );
    expect(notCacheable.message).toContain(
      'Operation "create" is not cacheable. Only read operations can be cached: findMany, findUnique'
    );
    expect(notCacheable.meta).toEqual({ model: "user", operation: "create" });

    const configuration = new CacheConfigurationError("missing cache", {
      cause: new Error("adapter unavailable"),
      meta: { driver: "memory" },
    });
    expect(configuration.originalCause).toBeInstanceOf(Error);
    expect(configuration.meta).toEqual({ driver: "memory" });
  });

  it("keeps every pending-operation refusal distinct", () => {
    const cases = [
      PendingOperationError.alreadyExecutedWithDriver("user", "create"),
      PendingOperationError.alreadyExecutedDefault("user", "create"),
      PendingOperationError.differentDriverConflict("user", "create"),
      PendingOperationError.clientMismatch("user", "create"),
      PendingOperationError.scopeMismatch("user", "create"),
    ];

    expect(cases.map((error) => error.code)).toEqual([
      VibORMErrorCode.OPERATION_ALREADY_EXECUTED,
      VibORMErrorCode.OPERATION_EXECUTION_CONFLICT,
      VibORMErrorCode.OPERATION_EXECUTION_CONFLICT,
      VibORMErrorCode.OPERATION_CLIENT_MISMATCH,
      VibORMErrorCode.OPERATION_SCOPE_MISMATCH,
    ]);
    for (const error of cases) {
      expect(error.meta).toEqual({ model: "user", operation: "create" });
    }
  });

  it("preserves options across each error family", () => {
    const cause = new Error("provider detail");
    const diagnostics = { includeParams: true, includeSql: true };
    const meta = { driver: "test", params: ["value"], query: "SELECT 1" };

    for (const error of [
      new UniqueConstraintError("unique", { cause, diagnostics, meta }),
      new ForeignKeyError("foreign", { cause, diagnostics, meta }),
      new NotNullConstraintError("not null", { cause, diagnostics, meta }),
      new CheckConstraintError("check", { cause, diagnostics, meta }),
      new ValueTooLongError("long", { cause, diagnostics, meta }),
      new QueryError("query", { cause, diagnostics, meta }),
      new TransactionError("transaction", { cause, diagnostics, meta }),
      new NestedWriteError("nested", "posts", {
        cause,
        diagnostics,
        meta,
      }),
    ]) {
      expect(error.originalCause).toBeInstanceOf(Error);
      expect(error.meta).toMatchObject(meta);
      expect(error.toJSON().meta).toMatchObject(meta);
    }
  });

  it("normalizes validation sources and summarizes multiple issues", () => {
    const operation = new ValidationError(
      {
        kind: "operation",
        operation: "createManyAndReturn",
        model: "user",
      },
      [
        { path: "data.0.id", message: "required" },
        { path: "data.1.id", message: "required" },
      ]
    );
    expect(operation.message).toBe(
      "Validation failed for createMany: 2 validation errors"
    );
    expect(operation.source).toEqual({
      kind: "operation",
      operation: "createMany",
      model: "user",
    });
    expect(operation.toJSON().source).toEqual(operation.source);

    expect(
      new ValidationError({ kind: "registry", property: "user" }, [
        { path: "user", message: "invalid" },
      ]).message
    ).toBe("Validation failed for schema registry: invalid");
    expect(
      new ValidationError(
        { kind: "schema-builder", builder: "model", path: "user" },
        [{ path: "user", message: "invalid" }]
      ).message
    ).toBe("Validation failed for model: invalid");
    expect(
      new ValidationError({ kind: "json-schema", target: "user" }, [
        { path: "$", message: "invalid" },
      ]).message
    ).toBe("Validation failed for JSON Schema: invalid");
  });

  it("rejects all unsupported vector operations with the same capability error", () => {
    for (const invoke of [
      unsupportedVector.literal,
      unsupportedVector.l2,
      unsupportedVector.cosine,
    ]) {
      expect(invoke).toThrowError("Load the pgvector extension.");
    }
  });

  it("keeps optional transaction metadata and migration causes", () => {
    expect(
      new InvalidTransactionInputError({ meta: { operation: "$transaction" } })
        .meta
    ).toEqual({ operation: "$transaction" });
    const migration = new MigrationError(
      "migration failed",
      VibORMErrorCode.MIGRATION_FAILED,
      {
        cause: new Error("provider failed"),
        meta: { migrationName: "001_init" },
      }
    );
    expect(migration.originalCause).toBeInstanceOf(Error);
    expect(migration.meta).toEqual({ migrationName: "001_init" });

    expect(
      new NotFoundError("user", "findUniqueOrThrow", {
        meta: { correlationId: "request-1" },
      }).meta
    ).toEqual({
      correlationId: "request-1",
      model: "user",
      operation: "findUniqueOrThrow",
    });
  });
});
