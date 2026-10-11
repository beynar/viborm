import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { getMigrationDriver } from "@src/migrations/drivers";
import { generateV1 } from "@src/migrations/generate-v1";
import { withLockedMigrationProducer } from "@src/migrations/pinned-session";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { describe, expect, test } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  sqliteEstateDriver,
} from "./_estate";

const BEGIN_IMMEDIATE = /BEGIN IMMEDIATE/i;
const SESSION_LOCK = /pg_try_advisory_lock|pg_advisory_unlock/;

const user = s.model({
  id: s.string().id(),
  email: s.string().unique(),
});

function answerPublicSchema(sql: string): unknown[] {
  if (sql.includes("pg_namespace")) return [{ present: 1 }];
  return [];
}

function mysqlSession(sqlMode: string, serverVersion: string | undefined) {
  const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
  driver.respond = (sql) => {
    if (sql.includes("SCHEMATA")) return [{ SCHEMA_NAME: "alpha" }];
    if (sql.includes("@@SESSION.sql_mode")) {
      return [{ sql_mode: sqlMode, server_version: serverVersion }];
    }
    return [];
  };
  return driver;
}

describe("pinned migration session", () => {
  test.each([
    "8.0.15",
    "10.11.9-MariaDB",
    undefined,
  ])("refuses MySQL version %s when enforced CHECK support is not proven", async (serverVersion) => {
    const driver = mysqlSession("STRICT_TRANS_TABLES", serverVersion);
    let ran = false;

    await expect(
      withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async () => {
          ran = true;
        }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      meta: { type: "unenforced-check-constraints" },
    });
    expect(ran).toBe(false);
  });

  test("admits MySQL 8.0.16, the first version that enforces CHECK", async () => {
    const driver = mysqlSession("STRICT_TRANS_TABLES", "8.0.16");

    await expect(
      withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async () => "ran"
      )
    ).resolves.toBe("ran");
  });

  test("refuses a strict-mode substring before the protected body", async () => {
    const driver = mysqlSession("NOT_STRICT_TRANS_TABLES", "8.4.0");
    let ran = false;

    await expect(
      withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async () => {
          ran = true;
        }
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
      meta: { type: "non-strict-sql-mode" },
    });
    expect(ran).toBe(false);
  });

  test("admits a trimmed exact STRICT_ALL_TABLES token", async () => {
    const driver = mysqlSession(
      "NO_ENGINE_SUBSTITUTION, STRICT_ALL_TABLES ",
      "8.4.0"
    );

    await expect(
      withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async () => "ran"
      )
    ).resolves.toBe("ran");
  });

  test("PostgreSQL takes a transaction lock on one producer, and its commit releases it", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const bound = getMigrationDriver(driver);
    const result = await withLockedMigrationProducer(
      driver,
      bound,
      async (pinned) => {
        await pinned._executeRaw("SELECT 1");
        return "ok";
      }
    );
    expect(result).toBe("ok");
    const { statements } = driver;
    expect(statements[0]).toBe("BEGIN");
    expect(statements[2]).toContain("pg_try_advisory_xact_lock");
    expect(statements.slice(-2)).toEqual(["SELECT 1", "COMMIT"]);
    expect(statements.join("\n")).not.toMatch(SESSION_LOCK);
    expect(new Set(driver.producers).size).toBe(1);
  });

  test("the lock goes with the rolled-back transaction when the protected body throws", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const bound = getMigrationDriver(driver);
    await expect(
      withLockedMigrationProducer(driver, bound, async () => {
        throw new Error("body failed");
      })
    ).rejects.toThrow("body failed");
    expect(driver.statements.at(-1)).toBe("ROLLBACK");
    expect(
      driver.statements.some((sql) => sql.includes("pg_advisory_unlock"))
    ).toBe(false);
  });

  test("an unproven lock acquisition refuses before the body runs", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    driver.lockAnswers = { acquire: [] };
    const bound = getMigrationDriver(driver);
    let ran = false;
    await expect(
      withLockedMigrationProducer(driver, bound, async () => {
        ran = true;
        return "ok";
      })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_LOCK_FAILED });
    expect(ran).toBe(false);
  });

  test("SQLite does not take a session lock", async () => {
    const driver = sqliteEstateDriver();
    const bound = getMigrationDriver(driver);
    const result = await withLockedMigrationProducer(
      driver,
      bound,
      async () => "ok"
    );
    expect(result).toBe("ok");
    expect(driver.statements.some((sql) => BEGIN_IMMEDIATE.test(sql))).toBe(
      false
    );
  });

  test("generate is offline and never acquires a lock", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const client = createClient({ schema: { user }, driver });
    await generateV1(client, new MemoryEstateStorage(), {
      dryRun: true,
      name: "init",
    });
    expect(
      driver.statements.some((sql) => sql.includes("pg_try_advisory"))
    ).toBe(false);
    await client.$disconnect();
  });

  test("dry-run apply on SQLite writes no control tables", async () => {
    const driver = sqliteEstateDriver();
    const client = createClient({ schema: { user }, driver });
    const migrations = createMigrationClient(client, {
      storage: new MemoryEstateStorage(),
    });
    await migrations.generate({ name: "init" });
    const preview = await migrations.apply({ dryRun: true });
    expect(preview.outcome).toBe("preview");
    expect((await migrations.status()).control).toBe("absent");
    expect(driver.statements.join("\n")).not.toContain("CREATE TABLE");
  });
});
