import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
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
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

const schema = { user };

const borrowedClients = new Set<PGlite>();

function createDriver(): PGliteDriver {
  const client = new PGlite();
  borrowedClients.add(client);
  return new PGliteDriver({ client });
}

afterEach(async () => {
  const clients = [...borrowedClients];
  borrowedClients.clear();
  await Promise.all(clients.map((client) => client.close()));
});

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
    await syncLiveSchema(client);

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
    await client.$disconnect();
  });

  test("maps raw not-null constraint errors", async () => {
    const driver = createDriver();
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
    const driver = createDriver();
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
    const driver = createDriver();
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
    const driver = createDriver();
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
    const driver = createDriver();
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
    const driver = createDriver();
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
    const driver = createDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
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
