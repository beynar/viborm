import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import { normalizeDriverError } from "@drivers/error-mapping";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import { PGlite } from "@electric-sql/pglite";
import {
  CheckConstraintError,
  ForeignKeyError,
  NestedWriteAssertionError,
  NotNullConstraintError,
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { push } from "@migrations";
import { s } from "@schema";

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
    const driver = new PGliteDriver({ client: new PGlite() });
    const client = createClient({ schema, driver });
    await push(client, { force: true });

    await client.user.create({
      data: {
        id: "duplicate-id",
        email: "first@example.com",
      },
    });

    await expect(
      client.user.create({
        data: {
          id: "duplicate-id",
          email: "second@example.com",
        },
      })
    ).rejects.toMatchObject({
      name: "UniqueConstraintError",
      meta: {
        driver: "pglite",
        model: "user",
        operation: "create",
      },
    });

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

  test("maps SQLITE_BUSY and SQLITE_LOCKED to retryable transaction errors", () => {
    const byCode = normalizeDriverError(
      Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
      context
    );
    expect(byCode).toBeInstanceOf(TransactionError);
    expect(byCode).toMatchObject({ code: VibORMErrorCode.DEADLOCK });

    const byMessage = normalizeDriverError(
      new Error("D1_ERROR: database is locked: SQLITE_BUSY"),
      context
    );
    expect(byMessage).toBeInstanceOf(TransactionError);
    expect(byMessage).toMatchObject({ code: VibORMErrorCode.DEADLOCK });

    const locked = normalizeDriverError(
      Object.assign(new Error("database table is locked"), {
        code: "SQLITE_LOCKED",
      }),
      context
    );
    expect(locked).toBeInstanceOf(TransactionError);
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
