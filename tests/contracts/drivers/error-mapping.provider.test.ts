import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import {
  CheckConstraintError,
  ClientInitializationError,
  ForeignKeyError,
  NotFoundError,
  NotNullConstraintError,
  UniqueConstraintError,
  ValueTooLongError,
} from "@errors";
import { instrumentation } from "@instrumentation/extension";
import type { LogEvent } from "@instrumentation/types";
import { s } from "@schema";
import { getFieldSqlName, getModelSqlName } from "@schema/hydration";
import { usePGliteSchemaFamily } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const schema = { user };

/**
 * One PGlite for the whole worker, one private schema for this file, emptied
 * before each test. Every driver below is built over that shared database and
 * MUST carry the suite's namespace: without it the driver addresses `public`,
 * where this suite has no tables at all.
 */
const getFamily = usePGliteSchemaFamily(schema);

function createDriver(): PGliteDriver {
  const family = getFamily();
  return new PGliteDriver({
    client: family.database,
    namespace: family.namespace,
  });
}

/**
 * Raw SQL is sent verbatim: the driver's namespace rewrites the ORM's
 * statements, never these. Every ad-hoc table below is addressed through the
 * suite's own schema, so it can never collide with a sibling suite sharing the
 * database.
 */
function qualify(table: string): string {
  return `"${getFamily().namespace}"."${table}"`;
}

async function createConstraintTables(driver: PGliteDriver): Promise<void> {
  // Dropped first: the schema outlives the test, so each test gets the same
  // empty constraint tables a fresh database used to hand it.
  await driver._executeRaw(
    `DROP TABLE IF EXISTS ${qualify("child")}, ${qualify("parent")}`
  );
  await driver._executeRaw(`
    CREATE TABLE ${qualify("parent")} (
      id TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      kind TEXT CHECK (kind IN ('allowed'))
    )
  `);
  await driver._executeRaw(`
    CREATE TABLE ${qualify("child")} (
      id TEXT PRIMARY KEY,
      parent_id TEXT NOT NULL REFERENCES ${qualify("parent")}(id)
    )
  `);
}

describe("PGlite driver error mapping", () => {
  test("maps ORM unique constraint errors with model and operation context", async () => {
    let loggedEvent: LogEvent | undefined;
    const driver = createDriver();
    const client = createClient({ schema, driver }).$extends(
      instrumentation({
        logging: {
          error: (event) => {
            loggedEvent = event;
          },
        },
      })
    );

    await client.user.create({
      data: { id: "secret-password-value", email: "first@example.com" },
    });
    const error = await client.user
      .create({
        data: { id: "secret-password-value", email: "second@example.com" },
      })
      .catch((caught) => caught);

    expect(error).toMatchObject({
      name: "UniqueConstraintError",
      meta: { driver: "pglite", model: "user", operation: "create" },
    });
    expect(JSON.stringify(error)).not.toContain("secret-password-value");
    expect(JSON.stringify(loggedEvent)).not.toContain("secret-password-value");
  });

  test("maps raw not-null constraint errors", async () => {
    const driver = createDriver();
    await createConstraintTables(driver);
    await expect(
      driver._executeRaw(
        `INSERT INTO ${qualify("parent")} (id, value, kind) VALUES ($1, $2, $3)`,
        ["missing-value", null, "allowed"]
      )
    ).rejects.toBeInstanceOf(NotNullConstraintError);
  });

  test("maps raw foreign key constraint errors", async () => {
    const driver = createDriver();
    await createConstraintTables(driver);
    await expect(
      driver._executeRaw(
        `INSERT INTO ${qualify("child")} (id, parent_id) VALUES ($1, $2)`,
        ["orphan-child", "missing-parent"]
      )
    ).rejects.toBeInstanceOf(ForeignKeyError);
  });

  test("maps raw check constraint errors", async () => {
    const driver = createDriver();
    await createConstraintTables(driver);
    await expect(
      driver._executeRaw(
        `INSERT INTO ${qualify("parent")} (id, value, kind) VALUES ($1, $2, $3)`,
        ["bad-kind", "value", "blocked"]
      )
    ).rejects.toBeInstanceOf(CheckConstraintError);
  });

  test("normalizes errors thrown inside batch execution", async () => {
    const driver = createDriver();
    await createConstraintTables(driver);
    await expect(
      driver._executeBatch([
        {
          sql: `INSERT INTO ${qualify("parent")} (id, value) VALUES ($1, $2)`,
          params: ["batch-dup", "first"],
        },
        {
          sql: `INSERT INTO ${qualify("parent")} (id, value) VALUES ($1, $2)`,
          params: ["batch-dup", "second"],
        },
      ])
    ).rejects.toBeInstanceOf(UniqueConstraintError);
  });
});

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

describe("Prisma-style catch on live PGlite errors", () => {
  test("P2002 unique constraint", async () => {
    const driver = createDriver();
    const client = createClient({ schema, driver });
    await client.user.create({ data: { id: "u1", email: "dup@example.com" } });
    const caught = await client.user
      .create({ data: { id: "u2", email: "dup@example.com" } })
      .catch((error: unknown) => error);
    expect(classifyLikePrisma(caught)).toBe("duplicate");
    expect(caught).toBeInstanceOf(UniqueConstraintError);
  });

  test("P2025 record required but not found", async () => {
    const driver = createDriver();
    const client = createClient({ schema, driver });
    const caught = await client.user
      .findUniqueOrThrow({ where: { id: "missing" } })
      .catch((error: unknown) => error);
    expect(classifyLikePrisma(caught)).toBe("not-found");
    expect(caught).toBeInstanceOf(NotFoundError);
  });

  test("P2003 foreign key constraint", async () => {
    const driver = createDriver();
    await createConstraintTables(driver);
    const caught = await driver
      ._executeRaw(
        `INSERT INTO ${qualify("child")} (id, parent_id) VALUES ($1, $2)`,
        ["orphan-child", "missing-parent"]
      )
      .catch((error: unknown) => error);
    expect(classifyLikePrisma(caught)).toBe("foreign-key");
    expect(caught).toBeInstanceOf(ForeignKeyError);
  });

  test("P2000 value too long for the column type", async () => {
    const driver = createDriver();
    const client = createClient({ schema, driver });
    const table = getModelSqlName(user);
    const column = getFieldSqlName(user, "email");
    await driver._executeRaw(
      `ALTER TABLE ${qualify(table)} ALTER COLUMN "${column}" TYPE varchar(5)`
    );
    const caught = await client.user
      .create({ data: { id: "u1", email: "way-too-long@example.com" } })
      .catch((error: unknown) => error);
    expect(classifyLikePrisma(caught)).toBe("too-long");
    expect(caught).toBeInstanceOf(ValueTooLongError);
    expect(caught).toMatchObject({
      meta: { model: "user", operation: "create" },
    });
  });

  test("a construction fault is not misfiled as one of the query codes", () => {
    const driver = createDriver();
    const client = createClient({ schema, driver });
    let caught: unknown;
    try {
      (
        client as unknown as { ghost: { findMany: () => unknown } }
      ).ghost.findMany();
    } catch (error) {
      caught = error;
    }
    expect(classifyLikePrisma(caught)).toBe("unhandled:P1012");
    expect(caught).toBeInstanceOf(ClientInitializationError);
  });
});
