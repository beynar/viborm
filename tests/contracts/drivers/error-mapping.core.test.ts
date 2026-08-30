import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import { attachExecutionContext } from "@drivers/driver-error-context";
import { normalizeDriverError } from "@drivers/error-mapping";
import { PGliteDriver } from "@drivers/pglite";
import type { Dialect, QueryResult } from "@drivers/types";
import { PGlite } from "@electric-sql/pglite";
// biome-ignore lint/performance/noNamespaceImport: the identity round-trip test discovers every concrete error class from the barrel
import * as allErrors from "@errors";
import {
  CheckConstraintError,
  ClientInitializationError,
  ForeignKeyError,
  isVibORMError,
  NestedWriteAssertionError,
  NotFoundError,
  NotNullConstraintError,
  QueryError,
  sanitizeErrorMetadata,
  TransactionError,
  UniqueConstraintError,
  ValidationError,
  ValueTooLongError,
  VibORMError,
  VibORMErrorCode,
} from "@errors";
import { instrumentation } from "@instrumentation/extension";
import type { LogEvent } from "@instrumentation/types";

import { s } from "@schema";
import { getFieldSqlName, getModelSqlName } from "@schema/hydration";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createOfficialTestExecutionContext } from "@tests/unit/instrumentation/_official-context";

const REDACTED_ERROR_CONTENT_PATTERN =
  /secret-password-value|SELECT id FROM users/;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const schema = { user };

async function createConstraintTables(driver: PGliteDriver): Promise<void> {
  await driver._executeRaw(`
    CREATE TABLE parent (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      kind TEXT CHECK (kind IN ('allowed'))
    )
  `);
  await driver._executeRaw(`
    CREATE TABLE child (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES parent(id)
    )
  `);
}

describe("driver error mapping", () => {
  test("maps ORM unique constraint errors with model and operation context", async () => {
    let loggedEvent: LogEvent | undefined;
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({
      schema,
      driver,
    }).$extends(
      instrumentation({
        logging: {
          error: (event) => {
            loggedEvent = event;
          },
        },
      })
    );
    await syncLiveSchema(client);

    await client.user.create({
      data: {
        id: "secret-password-value",
        email: "first@example.com",
      },
    });

    const error = await client.user
      .create({
        data: {
          id: "secret-password-value",
          email: "second@example.com",
        },
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      name: "UniqueConstraintError",
      meta: {
        driver: "pglite",
        model: "user",
        operation: "create",
      },
    });
    expect(JSON.stringify(error)).not.toContain("secret-password-value");
    expect(JSON.stringify(loggedEvent)).not.toContain("secret-password-value");

    await client.$disconnect();
  });

  test("maps raw not-null constraint errors", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    await createConstraintTables(driver);

    await expect(
      driver._executeRaw(
        "INSERT INTO parent (id, value, kind) VALUES ($1, $2, $3)",
        ["missing-value", null, "allowed"]
      )
    ).rejects.toBeInstanceOf(NotNullConstraintError);

    await driver.disconnect();
  });

  test("maps raw foreign key constraint errors", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    await createConstraintTables(driver);

    await expect(
      driver._executeRaw("INSERT INTO child (id, parent_id) VALUES ($1, $2)", [
        "orphan-child",
        "missing-parent",
      ])
    ).rejects.toBeInstanceOf(ForeignKeyError);

    await driver.disconnect();
  });

  test("maps raw check constraint errors", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    await createConstraintTables(driver);

    await expect(
      driver._executeRaw(
        "INSERT INTO parent (id, value, kind) VALUES ($1, $2, $3)",
        ["bad-kind", "value", "blocked"]
      )
    ).rejects.toBeInstanceOf(CheckConstraintError);

    await driver.disconnect();
  });

  test("normalizes errors thrown inside batch execution", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    await createConstraintTables(driver);

    await expect(
      driver._executeBatch([
        {
          sql: "INSERT INTO parent (id, value) VALUES ($1, $2)",
          params: ["batch-dup", "first"],
        },
        {
          sql: "INSERT INTO parent (id, value) VALUES ($1, $2)",
          params: ["batch-dup", "second"],
        },
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);

    await driver.disconnect();
  });
});

const context = { driverName: "test" };

describe("normalizeDriverError fixtures", () => {
  test("maps PlanetScale-shaped errors via errno in the message", () => {
    // @planetscale/database DatabaseError carries the MySQL errno only in text
    const raw = Object.assign(
      new Error(
        "target: mydb.-.primary: vttablet: rpc error: code = AlreadyExists desc = Duplicate entry 'x@y.dev' for key 'users.users_email_key' (errno 1062) (sqlstate 23000) (CallerID: unsecure_grpc_client): Sql: \"insert into users...\""
      ),
      { status: 400, body: { code: "ALREADY_EXISTS", message: "..." } }
    );

    const error = normalizeDriverError(raw, {
      driverName: "planetscale",
    });

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({
      meta: {
        driver: "planetscale",
        constraint: "users_email_key",
        table: "users",
        providerCode: "ALREADY_EXISTS",
        providerErrno: 1062,
        providerSqlState: "23000",
        providerStatus: 400,
      },
    });
  });

  test("maps PlanetScale-shaped deadlock errors to retryable transaction errors", () => {
    const raw = Object.assign(
      new Error(
        "target: mydb.-.primary: vttablet: rpc error: Deadlock found when trying to get lock; try restarting transaction (errno 1213) (sqlstate 40001)"
      ),
      { status: 400, body: { code: "ABORTED", message: "..." } }
    );

    const error = normalizeDriverError(raw, context);

    expect(error).toBeInstanceOf(TransactionError);
    expect(error).toMatchObject({ code: VibORMErrorCode.DEADLOCK });
  });

  test("aliases postgres.js constraint metadata fields", () => {
    const raw = Object.assign(
      new Error(
        'duplicate key value violates unique constraint "users_email_key"'
      ),
      {
        code: "23505",
        constraint_name: "users_email_key",
        table_name: "users",
        column_name: "email",
      }
    );

    const error = normalizeDriverError(raw, { driverName: "postgres" });

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({
      meta: {
        constraint: "users_email_key",
        table: "users",
        columns: ["email"],
      },
    });
  });

  test("parses the MySQL key name from duplicate entry messages", () => {
    const raw = Object.assign(
      new Error("Duplicate entry 'x@y.dev' for key 'users.users_email_key'"),
      { code: "ER_DUP_ENTRY", errno: 1062 }
    );

    const error = normalizeDriverError(raw, { driverName: "mysql2" });

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({
      meta: { constraint: "users_email_key", table: "users" },
    });
  });

  test("strips D1's SQLITE_CONSTRAINT suffix from constraint columns", () => {
    const raw = new Error(
      "D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT"
    );

    const error = normalizeDriverError(raw, { driverName: "d1" });

    expect(error).toBeInstanceOf(UniqueConstraintError);
    expect(error).toMatchObject({ meta: { columns: ["users.email"] } });
  });

  /**
   * Value-too-long (Prisma P2000), pinned per dialect.
   *
   * PostgreSQL SQLSTATE 22001 and MySQL errno 1406 are the two dialects that enforce a
   * declared column length; Prisma maps exactly those two to LengthMismatch → P2000
   * (quaint/src/connector/{postgres,mysql}/error.rs). SQLite is pinned as the documented
   * absence a few tests below.
   */
  test("maps PostgreSQL 22001 to a value-too-long error (P2000)", () => {
    const raw = Object.assign(
      new Error(
        'value too long for type character varying(5) for column "email"'
      ),
      { code: "22001", table_name: "users", column_name: "email" }
    );

    const error = normalizeDriverError(raw, { driverName: "postgres" });

    expect(error).toBeInstanceOf(ValueTooLongError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.code).toBe(VibORMErrorCode.VALUE_TOO_LONG);
    expect(error.prismaCode).toBe("P2000");
    expect(error.meta).toMatchObject({ table: "users", columns: ["email"] });
  });

  test("maps MySQL 1406 to a value-too-long error (P2000)", () => {
    const byErrno = normalizeDriverError(
      Object.assign(new Error("Data too long for column 'email' at row 1"), {
        code: "ER_DATA_TOO_LONG",
        errno: 1406,
        sqlState: "22001",
      }),
      { driverName: "mysql2" }
    );

    expect(byErrno).toBeInstanceOf(ValueTooLongError);
    if (!isVibORMError(byErrno)) throw new Error("expected a VibORMError");
    expect(byErrno.prismaCode).toBe("P2000");
    expect(byErrno.meta).toMatchObject({ providerErrno: 1406 });

    // PlanetScale carries the errno only in the message text.
    const byMessage = normalizeDriverError(
      new Error(
        "target: mydb.-.primary: vttablet: rpc error: Data too long for column 'email' at row 1 (errno 1406) (sqlstate 22001)"
      ),
      { driverName: "planetscale" }
    );

    expect(byMessage).toBeInstanceOf(ValueTooLongError);
    if (!isVibORMError(byMessage)) throw new Error("expected a VibORMError");
    expect(byMessage.prismaCode).toBe("P2000");
  });

  test("SQLite has no value-too-long error: SQLITE_TOOBIG stays a generic query error", () => {
    // SQLite ignores declared column lengths, so an over-long value is stored, never
    // rejected. SQLITE_TOOBIG is a different failure (the ~1GB SQLITE_MAX_LENGTH cap) and
    // Prisma leaves it unmapped too — quaint's SQLite connector has no arm for it, so it
    // falls through to a generic query error rather than P2000. VibORM matches that instead
    // of manufacturing a P2000 the dialect cannot back.
    const error = normalizeDriverError(
      Object.assign(new Error("string or blob too big"), {
        code: "SQLITE_TOOBIG",
      }),
      { driverName: "sqlite3" }
    );

    expect(error).toBeInstanceOf(QueryError);
    expect(error).not.toBeInstanceOf(ValueTooLongError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.prismaCode).toBeUndefined();
  });

  /**
   * SQLSTATE 23001 (restrict_violation), pinned beside 23503.
   *
   * Stock PostgreSQL folds a RESTRICT referential action into 23503, but the
   * pg-wire ecosystem (CockroachDB) raises restrict_violation under its own
   * SQLSTATE, carrying the same constraint/table metadata. Both are the same
   * refusal to the caller, so both are P2003.
   */
  test("maps PostgreSQL 23001 restrict violations to foreign key errors", () => {
    const error = normalizeDriverError(
      Object.assign(
        new Error(
          'update or delete on table "parent" violates foreign key constraint "child_parent_id_fkey" on table "child"'
        ),
        {
          code: "23001",
          constraint: "child_parent_id_fkey",
          table: "child",
        }
      ),
      { driverName: "pg" }
    );

    expect(error).toBeInstanceOf(ForeignKeyError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.code).toBe(VibORMErrorCode.FOREIGN_KEY_CONSTRAINT);
    expect(error.prismaCode).toBe("P2003");
    expect(error.meta).toMatchObject({
      providerCode: "23001",
      constraint: "child_parent_id_fkey",
      table: "child",
    });
  });

  test("maps SQLITE_BUSY and SQLITE_LOCKED to retryable transaction errors", () => {
    const byCode = normalizeDriverError(
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      { ...context, dialect: "sqlite" }
    );
    expect(byCode).toBeInstanceOf(TransactionError);
    expect(byCode).toMatchObject({ code: VibORMErrorCode.DEADLOCK });

    const byMessage = normalizeDriverError(
      new Error("D1_ERROR: database is locked: SQLITE_BUSY"),
      { ...context, dialect: "sqlite" }
    );
    expect(byMessage).toBeInstanceOf(TransactionError);
    expect(byMessage).toMatchObject({ code: VibORMErrorCode.DEADLOCK });

    const locked = normalizeDriverError(
      Object.assign(new Error("database table is locked"), {
        code: "SQLITE_LOCKED",
      }),
      { ...context, dialect: "sqlite" }
    );
    expect(locked).toBeInstanceOf(TransactionError);
  });

  /**
   * The extended families. better-sqlite3, bun:sqlite and libsql report
   * `sqlite3_extended_errcode`, so real contention arrives as
   * SQLITE_BUSY_RECOVERY or SQLITE_LOCKED_VTAB with a terse message that does
   * not repeat the symbol — an equality test against the two plain names sends
   * a retryable failure to the caller as a generic query error.
   */
  test.each([
    "SQLITE_BUSY_RECOVERY",
    "SQLITE_BUSY_SNAPSHOT",
    "SQLITE_BUSY_TIMEOUT",
    "SQLITE_LOCKED_SHAREDCACHE",
    "SQLITE_LOCKED_VTAB",
  ])("maps the extended code %s to a retryable transaction error", (code) => {
    const error = normalizeDriverError(
      Object.assign(new Error("database is locked"), { code }),
      { driverName: "better-sqlite3", dialect: "sqlite" }
    );

    expect(error).toBeInstanceOf(TransactionError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.code).toBe(VibORMErrorCode.DEADLOCK);
    // The name must also survive sanitizeProviderCode's allowlist, or the
    // caller keeps the retry and loses which family it came from.
    expect(error.meta.providerCode).toBe(code);
  });

  test("admits an underscore-delimited future SQLite contention family member", () => {
    const error = normalizeDriverError(
      Object.assign(new Error("database is busy"), {
        code: "SQLITE_BUSY_FUTURE_2",
      }),
      { driverName: "future-sqlite", dialect: "sqlite" }
    );

    expect(error).toBeInstanceOf(TransactionError);
    expect(error).toMatchObject({ code: VibORMErrorCode.DEADLOCK });
  });

  test.each([
    { name: "SQLITE_BUSY", value: 5 },
    { name: "SQLITE_LOCKED", value: 6 },
    { name: "SQLITE_BUSY_RECOVERY", value: 261 },
    { name: "SQLITE_LOCKED_SHAREDCACHE", value: 262 },
    { name: "SQLITE_BUSY_SNAPSHOT", value: 517 },
    { name: "SQLITE_LOCKED_VTAB", value: 518 },
    { name: "SQLITE_BUSY_TIMEOUT", value: 773 },
  ])("reads the numeric result code $value ($name) as contention on SQLite", ({
    value,
  }) => {
    // A binding that reports the extended code numerically only: nothing in
    // the error names SQLite, so the executing dialect is what makes the
    // low byte readable as SQLITE_BUSY / SQLITE_LOCKED.
    const byCode = normalizeDriverError(
      Object.assign(new Error("database is locked"), { code: value }),
      { driverName: "sqlite3", dialect: "sqlite" }
    );
    expect(byCode).toBeInstanceOf(TransactionError);
    expect(byCode).toMatchObject({ code: VibORMErrorCode.DEADLOCK });

    const byErrno = normalizeDriverError(
      Object.assign(new Error("database is locked"), { errno: value }),
      { driverName: "sqlite3", dialect: "sqlite" }
    );
    expect(byErrno).toBeInstanceOf(TransactionError);
    expect(byErrno).toMatchObject({ code: VibORMErrorCode.DEADLOCK });
  });

  test.each<{ label: string; dialect: Dialect | undefined }>([
    { label: "a MySQL connection", dialect: "mysql" },
    { label: "an unstated dialect", dialect: undefined },
  ])("refuses to read errno 1029 from $label as SQLite contention", ({
    dialect,
  }) => {
    // 1029 & 0xff === 5, the SQLITE_BUSY base code. The low byte alone proves
    // nothing across providers, so only the dialect separates a MySQL
    // failure from real contention — and a wrong answer here would hand the
    // write-race retry loop an error it must never re-run.
    const error = normalizeDriverError(
      Object.assign(new Error("MySQL server failure"), {
        errno: 1029,
        sqlState: "HY000",
      }),
      { driverName: "mysql2", dialect }
    );

    expect(error).toBeInstanceOf(QueryError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.isRetryable()).toBe(false);
  });

  test.each([
    { code: "SQLITE_BUSYWORK", message: "database is busy" },
    { code: "SQLITE_LOCKEDNESS", message: "database is locked" },
    {
      code: undefined,
      message: "provider failed with SQLITE_BUSYWORK and SQLITE_LOCKEDNESS",
    },
    { code: "SQLITE_BUSY_recovery", message: "database is busy" },
    { code: "SQLITE_BUSY_RECOVERYfoo", message: "database is busy" },
    { code: undefined, message: "xSQLITE_BUSY recovery failed" },
  ])("refuses the non-SQLite contention lookalike $code", ({
    code,
    message,
  }) => {
    const raw = Object.assign(new Error(message), code ? { code } : {});
    const error = normalizeDriverError(raw, {
      driverName: "sqlite-lookalike",
      dialect: "sqlite",
    });

    expect(error).toBeInstanceOf(QueryError);
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");
    expect(error.isRetryable()).toBe(false);
  });

  test.each<{ dialect: Dialect; driverName: string }>([
    { dialect: "postgresql", driverName: "pg" },
    { dialect: "mysql", driverName: "mysql2" },
  ])("does not arm write retry from SQLite symbols on $dialect", (driver) => {
    const byCode = normalizeDriverError(
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      driver
    );
    const byMessage = normalizeDriverError(
      new Error("provider rejected write: SQLITE_LOCKED_VTAB"),
      driver
    );

    for (const error of [byCode, byMessage]) {
      expect(error).toBeInstanceOf(QueryError);
      if (!isVibORMError(error)) throw new Error("expected a VibORMError");
      expect(error.isRetryable()).toBe(false);
    }
  });

  test("clones reused VibORM errors with request-scoped disclosure and attribution", () => {
    const shared = new QueryError("Shared safe error", {
      diagnostics: { includeParams: true, includeSql: true },
      meta: {
        driver: "driver-a",
        model: "account",
        operation: "create",
        correlationId: "source-correlation",
        query: "SELECT source_private",
        params: ["source-private-value"],
      },
    });

    const first = normalizeDriverError(shared, {
      driverName: "driver-a",
      model: "account",
      operation: "create",
      correlationId: "first-correlation",
      query: "SELECT first_private",
      params: ["first-private-value"],
      diagnostics: { includeParams: true, includeSql: true },
    });
    const disclosed = normalizeDriverError(first, {
      driverName: "driver-b",
      model: "user",
      operation: "findMany",
      correlationId: "second-correlation",
      query: "SELECT second_private",
      params: ["second-private-value"],
      diagnostics: { includeParams: true, includeSql: true },
    });
    const privateError = normalizeDriverError(first, {
      driverName: "driver-b",
      model: "post",
      operation: "delete",
      correlationId: "third-correlation",
    });

    expect(disclosed).not.toBe(shared);
    expect(privateError).not.toBe(shared);
    expect(disclosed).toBeInstanceOf(QueryError);
    expect(privateError).toBeInstanceOf(QueryError);
    if (
      !(disclosed instanceof QueryError && privateError instanceof QueryError)
    ) {
      throw new Error("expected cloned QueryError instances");
    }
    expect(disclosed).toMatchObject({
      meta: {
        driver: "driver-b",
        model: "user",
        operation: "findMany",
        correlationId: "second-correlation",
        query: "SELECT second_private",
        params: ["second-private-value"],
      },
    });
    expect(privateError).toMatchObject({
      meta: {
        driver: "driver-b",
        model: "post",
        operation: "delete",
        correlationId: "third-correlation",
      },
    });
    expect(JSON.stringify(disclosed)).not.toContain("first_private");
    expect(JSON.stringify(disclosed)).not.toContain("first-private-value");
    expect(privateError.meta).not.toHaveProperty("query");
    expect(privateError.meta).not.toHaveProperty("params");
    privateError.meta.query = "SELECT runtime_private";
    privateError.meta.params = ["runtime-private-value"];
    expect(JSON.stringify(privateError)).not.toContain("runtime_private");
    expect(JSON.stringify(privateError)).not.toContain("runtime-private-value");
    expect(shared.meta).toEqual({
      driver: "driver-a",
      model: "account",
      operation: "create",
      correlationId: "source-correlation",
      query: "SELECT source_private",
      params: ["source-private-value"],
    });
  });

  test("replaces every execution-owned field when a normalized error is reused", () => {
    const first = normalizeDriverError(new Error("private provider failure"), {
      driverName: "driver-a",
      model: "account",
      operation: "create",
      correlationId: "correlation-a",
      query: "SELECT request_a",
      params: ["request-a-secret"],
      diagnostics: { includeParams: true, includeSql: true },
    });
    const second = normalizeDriverError(first, {
      driverName: "driver-b",
      model: "user",
      operation: "findMany",
      correlationId: "correlation-b",
      query: "SELECT request_b",
      params: ["request-b-secret"],
      diagnostics: { includeParams: true, includeSql: true },
      forceContext: true,
    });
    const privateSecond = normalizeDriverError(first, {
      driverName: "driver-b",
      model: "post",
      operation: "delete",
      correlationId: "correlation-private-b",
      forceContext: true,
    });

    if (!(isVibORMError(second) && isVibORMError(privateSecond))) {
      throw new Error("expected VibORM errors");
    }
    expect(second.meta).toEqual({
      driver: "driver-b",
      model: "user",
      operation: "findMany",
      correlationId: "correlation-b",
      query: "SELECT request_b",
      params: ["request-b-secret"],
    });
    expect(JSON.stringify(second)).not.toContain("request_a");
    expect(JSON.stringify(second)).not.toContain("request-a-secret");
    expect(privateSecond.meta).toEqual({
      driver: "driver-b",
      model: "post",
      operation: "delete",
      correlationId: "correlation-private-b",
    });
  });

  test("clones validation errors without creating hollow subtype instances", () => {
    const source = new ValidationError(
      "create",
      [{ path: "email", message: "Email is invalid" }],
      { meta: { model: "user" } }
    );
    const normalized = normalizeDriverError(source, {
      driverName: "test",
      model: "user",
      operation: "create",
      correlationId: "validation-clone",
      forceContext: true,
    });

    expect(normalized).toBeInstanceOf(ValidationError);
    if (!(normalized instanceof ValidationError)) {
      throw new Error("expected ValidationError");
    }
    expect(normalized.operation).toBe("create");
    expect(normalized.issues).toEqual([
      { path: "email", message: "Email is invalid" },
    ]);
    expect(normalized.issues).not.toBe(source.issues);
    source.issues[0]!.message = "mutated";
    expect(normalized.issues[0]?.message).toBe("Email is invalid");
  });

  test("preserves non-operation validation sources while adding driver context", () => {
    const source = new ValidationError(
      { kind: "json-schema", target: "future-draft" },
      [{ path: "target", message: "Unsupported target" }]
    );
    const normalized = normalizeDriverError(source, {
      driverName: "test",
      correlationId: "validation-source-clone",
      forceContext: true,
    });

    expect(normalized).toBeInstanceOf(ValidationError);
    if (!(normalized instanceof ValidationError)) {
      throw new Error("expected ValidationError");
    }
    expect(normalized.source).toEqual({
      kind: "json-schema",
      target: "future-draft",
    });
    expect(normalized.operation).toBeUndefined();
    expect(normalized.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(normalized.prismaCode).toBeUndefined();
  });

  test("flattens custom error subclasses instead of creating hollow instances", () => {
    class StatefulQueryError extends QueryError {
      readonly #marker = "initialized";

      getMarker(): string {
        return this.#marker;
      }
    }

    const source = new StatefulQueryError("Custom query failure");
    expect(source.getMarker()).toBe("initialized");

    const normalized = normalizeDriverError(source, {
      driverName: "test",
      model: "user",
      operation: "findMany",
      correlationId: "custom-subclass",
    });

    expect(normalized).toBeInstanceOf(VibORMError);
    expect(normalized).not.toBeInstanceOf(StatefulQueryError);
    expect(normalized.name).toBe("VibORMError");
    if (!isVibORMError(normalized)) {
      throw new Error("expected flattened VibORMError");
    }
    expect(normalized.toJSON().name).toBe("VibORMError");
  });

  test("keeps metadata sanitization total for revoked parameter arrays", () => {
    const revoked = Proxy.revocable<unknown[]>([], {});
    revoked.revoke();

    expect(() =>
      sanitizeErrorMetadata({ params: revoked.proxy }, { includeParams: true })
    ).not.toThrow();
    expect(
      sanitizeErrorMetadata({ params: revoked.proxy }, { includeParams: true })
    ).toEqual({});
    expect(
      () =>
        new QueryError("Safe query failure", {
          diagnostics: { includeParams: true },
          meta: { params: revoked.proxy },
        })
    ).not.toThrow();
  });

  test("flattens validation errors whose runtime issue array is unreadable", () => {
    const source = new ValidationError("create", [
      { path: "email", message: "Email is invalid" },
    ]);
    const revoked = Proxy.revocable<unknown[]>([], {});
    revoked.revoke();
    Object.defineProperty(source, "issues", {
      configurable: true,
      value: revoked.proxy,
    });

    const normalized = normalizeDriverError(source, {
      driverName: "test",
      model: "user",
      operation: "create",
    });

    expect(normalized).toBeInstanceOf(VibORMError);
    expect(normalized).not.toBeInstanceOf(ValidationError);
    expect(normalized.name).toBe("VibORMError");
  });

  test("maps batch-plan assertion failures to NestedWriteAssertionError on every dialect", () => {
    const assertQuery =
      'SELECT CASE WHEN EXISTS (SELECT 1) THEN 1 ELSE 0 END AS "__viborm_assert__"';

    // PG: division by zero (SQLSTATE 22012)
    const pg = normalizeDriverError(
      Object.assign(new Error("division by zero"), { code: "22012" }),
      { driverName: "pglite", query: assertQuery }
    );
    expect(pg).toBeInstanceOf(NestedWriteAssertionError);

    // MySQL: invalid JSON text (errno 3141)
    const mysql = normalizeDriverError(
      Object.assign(
        new Error(
          'Invalid JSON text in argument 1 to function json_extract: "Invalid value." at position 0.'
        ),
        { errno: 3141, code: "ER_INVALID_JSON_TEXT_IN_PARAM" }
      ),
      { driverName: "mysql2", query: assertQuery }
    );
    expect(mysql).toBeInstanceOf(NestedWriteAssertionError);

    // SQLite: malformed JSON
    const sqlite = normalizeDriverError(new Error("malformed JSON"), {
      driverName: "sqlite3",
      query: assertQuery,
    });
    expect(sqlite).toBeInstanceOf(NestedWriteAssertionError);

    // A user query dividing by zero is NOT an assertion failure
    const userError = normalizeDriverError(
      Object.assign(new Error("division by zero"), { code: "22012" }),
      { driverName: "pglite", query: 'UPDATE "users" SET "score" = 1 / 0' }
    );
    expect(userError).not.toBeInstanceOf(NestedWriteAssertionError);
  });
});

class FakeNativeBatchDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  constructor() {
    super("sqlite", "fake-batch");
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // nothing to close
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (tx: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }

  protected override async executeBatch(): Promise<never> {
    throw new Error(
      "D1_ERROR: UNIQUE constraint failed: users.email: SQLITE_CONSTRAINT"
    );
  }
}

describe("native batch error normalization", () => {
  test("normalizes raw errors from native batch overrides", async () => {
    const driver = new FakeNativeBatchDriver();

    await expect(
      driver._executeBatch([{ sql: "INSERT INTO users DEFAULT VALUES" }])
    ).rejects.toMatchObject({
      name: "UniqueConstraintError",
      meta: { driver: "fake-batch" },
    });
  });
});

class NumericBusyDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("sqlite", "numeric-busy");
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw createNumericBusyError();
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw createNumericBusyError();
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
}

function createNumericBusyError(): Error {
  return Object.assign(new Error("database is locked"), { errno: 261 });
}

describe("SQLite contention reaching the normalizer through a driver", () => {
  test("threads the driver's own dialect into statement normalization", async () => {
    // Nothing in this provider error names SQLite — no symbolic code, no
    // symbol in the message. Only the executing driver's dialect makes 261
    // readable as SQLITE_BUSY_RECOVERY, so this pins the threading rather
    // than the mapping.
    const driver = new NumericBusyDriver();

    await expect(
      driver._executeRaw("INSERT INTO users DEFAULT VALUES")
    ).rejects.toMatchObject({
      name: "TransactionError",
      code: VibORMErrorCode.DEADLOCK,
      meta: { driver: "numeric-busy", providerErrno: 261 },
    });

    await driver.disconnect();
  });
});

class SecretFailingDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();

  constructor() {
    super("sqlite", "secret-failing");
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource to release.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw createSecretProviderError();
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw createSecretProviderError();
  }

  protected async transaction<T>(
    _client: object,
    fn: (tx: object) => Promise<T>
  ): Promise<T> {
    return fn({});
  }
}

function createSecretProviderError(): Error {
  const deepestCause = Object.assign(new Error("deep nested provider detail"), {
    code: "ECONNRESET",
  });
  const middleCause = new Error("middle nested provider detail");
  Object.defineProperty(middleCause, "cause", { value: deepestCause });
  const error = new Error("fixture provider failure for secret-password-value");
  Object.defineProperties(error, {
    cause: { value: middleCause },
    code: { enumerable: true, value: "UNKNOWN" },
    errno: { enumerable: true, value: 9999 },
    sqlState: { enumerable: true, value: "HY000" },
    status: { enumerable: true, value: 503 },
    detail: {
      enumerable: true,
      value: "detail contains secret-password-value",
    },
    meta: {
      enumerable: true,
      value: { token: "secret-password-value" },
    },
  });
  return error;
}

describe("serialized error disclosure", () => {
  test("preserves declared diagnostics and rejects deceptive value shapes", () => {
    const declared = sanitizeErrorMetadata({
      actualChecksum: "actual-checksum",
      autoIncrement: true,
      column: "id",
      commitCertainty: "committed",
      conflictsWith: "set",
      context: "upsertCreate",
      expectedChecksum: "expected-checksum",
      hint: "Async validation is not supported",
      migrationIndex: 3,
      migrationsDir: "/migrations",
      relations: ["posts", "profile"],
      step: "upsert",
    });

    expect(declared).toEqual({
      actualChecksum: "actual-checksum",
      autoIncrement: true,
      column: "id",
      commitCertainty: "committed",
      conflictsWith: "set",
      context: "upsertCreate",
      expectedChecksum: "expected-checksum",
      hint: "Async validation is not supported",
      migrationIndex: 3,
      migrationsDir: "/migrations",
      relations: ["posts", "profile"],
      step: "upsert",
    });

    const canary = "phase7-meta-shape-canary";
    const deceptive = sanitizeErrorMetadata({
      autoIncrement: canary,
      columns: ["id", { token: canary }],
      commitCertainty: "certainly-secret",
      expectedChecksum: { token: canary },
      model: { token: canary },
      params: [canary],
      providerCode: canary,
      query: canary,
      relations: [canary, 1],
      timeout: Number.POSITIVE_INFINITY,
      token: canary,
    });

    expect(deceptive).toEqual({});
    expect(JSON.stringify(deceptive)).not.toContain(canary);
  });

  test.each([
    {
      name: "neither SQL nor params",
      diagnostics: undefined,
      hasSql: false,
      hasParams: false,
    },
    {
      name: "SQL only",
      diagnostics: { includeSql: true },
      hasSql: true,
      hasParams: false,
    },
    {
      name: "params only",
      diagnostics: { includeParams: true },
      hasSql: false,
      hasParams: true,
    },
    {
      name: "SQL and params",
      diagnostics: { includeSql: true, includeParams: true },
      hasSql: true,
      hasParams: true,
    },
  ])("discloses $name only when explicitly requested", async (scenario) => {
    const driver = new SecretFailingDriver();
    const secret = "secret-password-value";
    const query = "SELECT id FROM users WHERE password = ?";
    const cyclic: Record<string, unknown> = { id: 1n };
    const jsonParameter = {
      sql: "business-sql",
      query: "business-query",
      params: ["business-param"],
      values: ["business-value"],
    };
    cyclic.self = cyclic;
    const context = createOfficialTestExecutionContext(
      { diagnostics: scenario.diagnostics },
      {
        model: "user",
        operation: "findMany",
        correlationId: "error-disclosure",
      }
    );

    let thrown: unknown;
    try {
      await driver._executeRaw(
        query,
        [secret, 2n, cyclic, jsonParameter],
        context
      );
    } catch (error) {
      thrown = error;
    }

    expect(isVibORMError(thrown)).toBe(true);
    if (!isVibORMError(thrown)) {
      throw new Error("expected a VibORMError");
    }

    const serialized = JSON.stringify(thrown.toJSON());
    expect(thrown.meta).toMatchObject({
      driver: "secret-failing",
      model: "user",
      operation: "findMany",
      correlationId: "error-disclosure",
      providerCode: "UNKNOWN",
      providerErrno: 9999,
      providerSqlState: "HY000",
      providerStatus: 503,
    });
    if (scenario.hasSql) {
      expect(thrown.meta).toHaveProperty("query", query);
    } else {
      expect(thrown.meta).not.toHaveProperty("query");
    }
    if (scenario.hasParams) {
      expect(thrown.meta.params).toEqual([
        secret,
        "2",
        { id: "1", self: "[Circular]" },
        jsonParameter,
      ]);
    } else {
      expect(thrown.meta).not.toHaveProperty("params");
    }
    expect(thrown.message).toBe("Query execution failed");
    expect(thrown.originalCause?.message).toBe(
      "Underlying error details redacted"
    );
    expect(thrown.originalCause).not.toHaveProperty("meta");
    expect(serialized).not.toContain("fixture provider failure");
    expect(serialized).not.toContain("middle nested provider detail");
    expect(serialized).not.toContain("deep nested provider detail");
    expect(serialized).toContain("ECONNRESET");
    expect(serialized.match(/Underlying error details redacted/g)?.length).toBe(
      3
    );
    if (!scenario.hasSql) expect(serialized).not.toContain(query);
    if (!scenario.hasParams) expect(serialized).not.toContain(secret);
  });

  test("applies logger disclosure independently to raw and serialized errors", async () => {
    let event: LogEvent | undefined;
    const driver = new SecretFailingDriver();
    const context = createOfficialTestExecutionContext(
      {
        diagnostics: { includeSql: true, includeParams: true },
        logging: {
          error: (received) => {
            event = received;
          },
          includeSql: false,
          includeParams: false,
        },
      },
      { model: "user", operation: "findMany" }
    );

    await driver
      ._executeRaw(
        "SELECT id FROM users WHERE password = ?",
        ["secret-password-value"],
        context
      )
      .catch(() => undefined);

    expect(event).toBeDefined();
    expect(event?.sql).toBeUndefined();
    expect(event?.params).toBeUndefined();
    expect(JSON.stringify(event?.error)).not.toMatch(
      REDACTED_ERROR_CONTENT_PATTERN
    );
  });

  test("keeps toJSON total and private after runtime mutation", () => {
    const canary = "phase7-secret-canary";
    const error = normalizeDriverError(
      Object.assign(new Error(`provider ${canary}`), {
        code: "23505",
        sqlState: "23505",
        status: 503,
      }),
      {
        driverName: "test",
        model: "user",
        operation: "create",
        correlationId: "mutation-isolation",
      }
    );
    if (!isVibORMError(error)) throw new Error("expected a VibORMError");

    error.meta.token = canary;
    error.meta.params = [canary];
    Object.defineProperty(error, "originalCause", {
      configurable: true,
      value: Object.assign(new Error(canary), {
        code: canary,
        meta: { token: canary },
      }),
    });
    Object.defineProperty(error, "timestamp", {
      configurable: true,
      value: { toISOString: () => canary },
    });
    error.name = canary;
    error.message = canary;

    expect(() => JSON.stringify(error)).not.toThrow();
    const serialized = JSON.stringify(error);
    expect(serialized).not.toContain(canary);
    expect(JSON.parse(serialized)).toMatchObject({
      name: "UniqueConstraintError",
      message: "Unique constraint violation",
      code: VibORMErrorCode.UNIQUE_CONSTRAINT,
      meta: {
        driver: "test",
        model: "user",
        operation: "create",
        correlationId: "mutation-isolation",
        providerCode: "23505",
        providerSqlState: "23505",
        providerStatus: 503,
      },
    });
  });

  test("isolates reused error clones and rejects malicious provider tokens", () => {
    const canary = "phase7-secret-canary";
    const uppercaseCanary = "TOPSECRET";
    const shared = new QueryError("Safe shared error", {
      cause: Object.assign(new Error("provider detail"), { code: "23505" }),
      meta: { operation: "execute" },
    });
    const first = normalizeDriverError(shared, {
      driverName: "test",
      model: "user",
      operation: "findMany",
      correlationId: "first",
    });
    shared.meta.model = canary;
    shared.meta.operation = canary;
    shared.meta.correlationId = canary;
    const second = normalizeDriverError(shared, {
      driverName: "test",
      model: "post",
      operation: "delete",
      correlationId: "second",
    });
    const reusedAttributed = normalizeDriverError(first, {
      driverName: "test",
      model: "comment",
      operation: "update",
      correlationId: "third",
    });
    if (
      !(
        isVibORMError(first) &&
        isVibORMError(second) &&
        isVibORMError(reusedAttributed)
      )
    ) {
      throw new Error("expected VibORM errors");
    }

    first.meta.token = canary;
    first.timestamp.setTime(Number.NaN);
    if (first.originalCause) first.originalCause.message = canary;

    expect(JSON.stringify(first)).not.toContain(canary);
    expect(JSON.stringify(second)).not.toContain(canary);
    expect(JSON.stringify(reusedAttributed)).not.toContain(canary);
    expect(second).toBeInstanceOf(QueryError);
    expect(second.toJSON()).toMatchObject({
      name: "QueryError",
      meta: {
        model: "post",
        operation: "delete",
        correlationId: "second",
      },
    });
    expect(reusedAttributed.toJSON()).toMatchObject({
      name: "QueryError",
      meta: {
        model: "comment",
        operation: "update",
        correlationId: "third",
      },
    });

    const malicious = normalizeDriverError(
      Object.assign(new Error(canary), {
        code: uppercaseCanary,
        sqlState: uppercaseCanary,
        status: uppercaseCanary,
        meta: { token: canary },
      }),
      { driverName: "test" }
    );
    expect(JSON.stringify(malicious)).not.toContain(canary);
    expect(JSON.stringify(malicious)).not.toContain(uppercaseCanary);
    expect(malicious).toMatchObject({ meta: { driver: "test" } });
    if (!isVibORMError(malicious)) throw new Error("expected a VibORMError");
    expect(malicious.meta).not.toHaveProperty("providerCode");
    expect(malicious.meta).not.toHaveProperty("providerSqlState");
    expect(malicious.meta).not.toHaveProperty("providerStatus");
  });
});

/**
 * A `catch` written for Prisma, run against live errors.
 *
 * What has to port is the HANDLER, not the error class: a Prisma codebase switches on a
 * P-code, so the same switch must keep classifying VibORM failures once `error.code` is
 * re-spelled `error.prismaCode`. Every probe below comes from a real database round-trip
 * (PGlite), not a hand-built error object.
 */
function classifyLikePrisma(error: unknown): string {
  const code = (error as { prismaCode?: string } | null)?.prismaCode;
  switch (code) {
    case "P2002":
      return "duplicate";
    case "P2003":
      return "foreign-key";
    case "P2025":
      return "not-found";
    case "P2000":
      return "too-long";
    default:
      return `unhandled:${String(code)}`;
  }
}

describe("Prisma-style catch on live errors", () => {
  test("P2002 unique constraint", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);

    await client.user.create({ data: { id: "u1", email: "dup@example.com" } });
    const caught = await client.user
      .create({ data: { id: "u2", email: "dup@example.com" } })
      .catch((error: unknown) => error);

    expect(classifyLikePrisma(caught)).toBe("duplicate");
    expect(caught).toBeInstanceOf(UniqueConstraintError);

    await client.$disconnect();
  });

  test("P2025 record required but not found", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);

    const caught = await client.user
      .findUniqueOrThrow({ where: { id: "missing" } })
      .catch((error: unknown) => error);

    expect(classifyLikePrisma(caught)).toBe("not-found");
    expect(caught).toBeInstanceOf(NotFoundError);

    await client.$disconnect();
  });

  test("P2003 foreign key constraint", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    await createConstraintTables(driver);

    const caught = await driver
      ._executeRaw("INSERT INTO child (id, parent_id) VALUES ($1, $2)", [
        "orphan-child",
        "missing-parent",
      ])
      .catch((error: unknown) => error);

    expect(classifyLikePrisma(caught)).toBe("foreign-key");
    expect(caught).toBeInstanceOf(ForeignKeyError);

    await driver.disconnect();
  });

  test("P2000 value too long for the column type", async () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);

    // syncLiveSchema() emits TEXT for s.string(); narrow the column so the database actually enforces a
    // length and raises SQLSTATE 22001 on the write path.
    const table = getModelSqlName(user);
    const column = getFieldSqlName(user, "email");
    await driver._executeRaw(
      `ALTER TABLE "${table}" ALTER COLUMN "${column}" TYPE varchar(5)`
    );

    const caught = await client.user
      .create({ data: { id: "u1", email: "way-too-long@example.com" } })
      .catch((error: unknown) => error);

    expect(classifyLikePrisma(caught)).toBe("too-long");
    expect(caught).toBeInstanceOf(ValueTooLongError);
    expect(caught).toMatchObject({
      meta: { model: "user", operation: "create" },
    });

    await client.$disconnect();
  });

  test("a construction fault is not misfiled as one of the query codes", () => {
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({ schema, driver });

    let caught: unknown;
    try {
      (
        client as unknown as { ghost: { findMany: () => unknown } }
      ).ghost.findMany();
    } catch (error) {
      caught = error;
    }

    // Unknown model access fails before any I/O — P1012 (Prisma's initialization family),
    // never one of the P2xxx codes the handler above claims.
    expect(classifyLikePrisma(caught)).toBe("unhandled:P1012");
    expect(caught).toBeInstanceOf(ClientInitializationError);
  });

  // One factory per concrete VibORMError class exported from @errors. The
  // discovery loop below fails on any class missing here, so a newly added
  // error class cannot silently fall back to bare VibORMError inside
  // getCloneConstructor (src/drivers/driver-error-context.ts).
  const cloneFactories: Record<string, () => VibORMError> = {
    CacheConfigurationError: () =>
      new allErrors.CacheConfigurationError("cache misconfigured"),
    CacheInvalidKeyError: () => new allErrors.CacheInvalidKeyError("bad key"),
    CacheInvalidTTLError: () => new allErrors.CacheInvalidTTLError("bad ttl"),
    CacheOperationNotCacheableError: () =>
      new allErrors.CacheOperationNotCacheableError("create", ["findMany"]),
    CheckConstraintError: () => new CheckConstraintError("check failed"),
    ClientInitializationError: () =>
      new ClientInitializationError("cannot build client"),
    ConnectionError: () => new allErrors.ConnectionError("connection refused"),
    FeatureNotSupportedError: () =>
      new allErrors.FeatureNotSupportedError("savepoints", "create"),
    ForeignKeyError: () => new ForeignKeyError("fk violated"),
    InvalidTransactionInputError: () =>
      new allErrors.InvalidTransactionInputError(),
    MigrationError: () => new allErrors.MigrationError("migration failed"),
    NestedWriteAssertionError: () =>
      new NestedWriteAssertionError("assertion failed"),
    NestedWriteError: () =>
      new allErrors.NestedWriteError("nested write failed", "posts"),
    NotFoundError: () => new NotFoundError("user", "findUnique"),
    NotNullConstraintError: () => new NotNullConstraintError("null violation"),
    PendingOperationError: () =>
      new allErrors.PendingOperationError(
        "already executed",
        VibORMErrorCode.OPERATION_ALREADY_EXECUTED
      ),
    QueryEngineError: () => new allErrors.QueryEngineError("engine failed"),
    QueryError: () => new QueryError("query failed"),
    TransactionError: () => new TransactionError("transaction failed"),
    UniqueConstraintError: () => new UniqueConstraintError("duplicate"),
    UnsupportedOperationError: () =>
      new allErrors.UnsupportedOperationError("shape not supported"),
    ValidationError: () =>
      new ValidationError("create", [{ path: "email", message: "invalid" }]),
    ValueTooLongError: () => new ValueTooLongError("value too long"),
    VibORMError: () =>
      new VibORMError("base failure", VibORMErrorCode.INTERNAL_ERROR),
  };

  test("every concrete error class keeps its identity through attachExecutionContext", () => {
    const classes = Object.values(allErrors as Record<string, unknown>).filter(
      (value): value is new (...args: never[]) => VibORMError =>
        typeof value === "function" &&
        (value === VibORMError || value.prototype instanceof VibORMError)
    );
    expect(classes.length).toBeGreaterThan(0);

    for (const cls of classes) {
      const factory = cloneFactories[cls.name];
      if (!factory) {
        throw new Error(
          `${cls.name} has no factory in this test — add one here, and add the class to CLONE_CONSTRUCTORS in src/drivers/driver-error-context.ts`
        );
      }
      const source = factory();
      const clone = attachExecutionContext(source, { driverName: "pg" });
      expect(Object.getPrototypeOf(clone)).toBe(cls.prototype);
      expect(clone.code).toBe(source.code);
    }
  });
});
