/**
 * Read-only migration status.
 *
 * `status()` never bootstraps control tables. A missing pair of control tables
 * is "absent"; any other failure surfaces as itself.
 */

import { createClient } from "@client/client";
import { createMigrationClient } from "@migrations";
import { generateV1 as generate } from "@migrations/generate-v1";
import { statusV1 as status } from "@migrations/operators";
import type { MigrationClient } from "@migrations/push/planner";
import { s } from "@schema";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryStorage, pgEstateDriver, type RecordingDriver } from "./_estate";

const schema = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

function clientFor(driver: RecordingDriver): MigrationClient {
  return { $driver: driver, $schema: schema };
}

describe("status is SELECT-only", () => {
  it("never creates the control tables", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    driver.respond = (sql: string) => {
      if (sql.includes("pg_namespace") && !sql.includes("pg_class")) {
        return [{ present: 1 }];
      }
      if (sql.includes("EXISTS") && sql.includes("pg_class")) {
        return [{ exists: 0 }];
      }
      return [];
    };

    const report = await status(clientFor(driver), storage);
    expect(report.control).toBe("absent");
    expect(report.pending).toHaveLength(1);

    const executed = driver.statements.join("\n");
    expect(executed).toContain("pg_class");
    expect(executed).not.toContain("CREATE TABLE");
  });

  it("surfaces a control-table failure instead of reporting an empty estate", async () => {
    const driver = pgEstateDriver("alpha");
    const storage = new MemoryStorage();
    await generate(clientFor(driver), storage, { name: "init" });
    driver.respond = (sql) =>
      sql.includes("EXISTS") && sql.includes("pg_class")
        ? new Error("permission denied for relation")
        : [];

    await expect(status(clientFor(driver), storage)).rejects.toThrow();
  });
});

describe("read-only control presence, per dialect", () => {
  it("distinguishes absent control tables on a live SQLite database", async () => {
    const driver = createInMemorySQLite3Driver();
    const client = createClient({ schema, driver });
    const storage = new MemoryStorage();
    const migrations = createMigrationClient(client, { storage });

    try {
      await migrations.generate({ name: "init" });

      const before = await migrations.status();
      expect(before.control).toBe("absent");
      expect(before.pending).toHaveLength(1);
      await expect(
        driver._executeRaw("SELECT 1 FROM _viborm_migration_state")
      ).rejects.toThrow();

      await migrations.apply();
      const after = await migrations.status();
      expect(after.control).toBe("present");
      expect(after.pending).toEqual([]);
    } finally {
      await driver.disconnect();
    }
  });
});
