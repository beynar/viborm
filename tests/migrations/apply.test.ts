/**
 * Migration Apply / Down Round-Trip Tests
 *
 * Generates up+down migrations for schema changes, applies them,
 * rolls them back, and asserts the schema round-trips.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { apply, down, generate, status } from "@migrations";
import { MigrationStorageDriver } from "@migrations/storage";
import { s } from "@schema";
import { describe, expect, it } from "vitest";
import { createInMemoryPGliteDriver } from "../fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "../fixtures/drivers/sqlite3";

class MemoryStorageDriver extends MigrationStorageDriver {
  private files = new Map<string, string>();

  constructor() {
    super("memory");
  }

  get(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  put(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

const schemaV1 = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
  }),
};

const schemaV2 = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
  }),
};

function runApplyDownRoundTrip(
  driverName: string,
  createDriver: () => AnyDriver
): void {
  describe(`apply/down round-trip (${driverName})`, () => {
    it("generates up+down, applies, rolls back, and re-applies", async () => {
      const storage = new MemoryStorageDriver();
      const driver = createDriver();
      const clientV1 = createClient({ schema: schemaV1, driver });

      // Migration 0: create users table
      const gen1 = await generate(clientV1, {
        storageDriver: storage,
        name: "init",
      });
      expect(gen1.entry).not.toBeNull();
      expect(gen1.downSql.join("\n")).toContain("DROP TABLE");

      const downFile1 = await storage.readDownMigration(gen1.entry!);
      expect(downFile1).toContain("DROP TABLE");

      const applied1 = await apply(clientV1, { storageDriver: storage });
      expect(applied1.applied).toHaveLength(1);

      await clientV1.user.create({ data: { id: "u1", email: "a@b.c" } });

      // Migration 1: add nullable name column
      const clientV2 = createClient({ schema: schemaV2, driver });
      const gen2 = await generate(clientV2, {
        storageDriver: storage,
        name: "add-name",
      });
      expect(gen2.entry).not.toBeNull();

      const applied2 = await apply(clientV2, { storageDriver: storage });
      expect(applied2.applied).toHaveLength(1);

      await clientV2.user.update({
        where: { id: "u1" },
        data: { name: "Ann" },
      });

      // Dry run previews without executing
      const dryRun = await down(clientV2, {
        storageDriver: storage,
        steps: 1,
        dryRun: true,
      });
      expect(dryRun.rolledBack.map((e) => e.name)).toEqual(["add-name"]);
      const stillThere = await driver._executeRaw(
        'SELECT "name" FROM "user" WHERE "id" = \'u1\''
      );
      expect(stillThere.rows).toHaveLength(1);

      // Roll back migration 1: name column dropped
      const down1 = await down(clientV2, { storageDriver: storage, steps: 1 });
      expect(down1.rolledBack.map((e) => e.name)).toEqual(["add-name"]);

      await expect(
        driver._executeRaw('SELECT "name" FROM "user" WHERE "id" = \'u1\'')
      ).rejects.toThrow();

      // Row data survives the column rollback
      const row = await driver._executeRaw(
        'SELECT "email" FROM "user" WHERE "id" = \'u1\''
      );
      expect(row.rows).toHaveLength(1);

      // Roll back migration 0: table dropped
      const down0 = await down(clientV1, { storageDriver: storage, steps: 1 });
      expect(down0.rolledBack.map((e) => e.name)).toEqual(["init"]);

      await expect(
        driver._executeRaw('SELECT "id" FROM "user"')
      ).rejects.toThrow();

      // Everything is pending again
      const statuses = await status(clientV1, { storageDriver: storage });
      expect(statuses).toHaveLength(2);
      expect(statuses.every((st) => !st.applied)).toBe(true);

      // Re-apply both migrations: schema round-trips
      const reapplied = await apply(clientV2, { storageDriver: storage });
      expect(reapplied.applied).toHaveLength(2);

      await clientV2.user.create({
        data: { id: "u2", email: "b@c.d", name: "Bob" },
      });
      const users = await clientV2.user.findMany({});
      expect(users).toHaveLength(1);

      // No further schema changes detected after round-trip
      const gen3 = await generate(clientV2, {
        storageDriver: storage,
        name: "noop",
      });
      expect(gen3.entry).toBeNull();
      expect(gen3.operations).toHaveLength(0);
    });

    it("rolls back to a specific migration with `to`", async () => {
      const storage = new MemoryStorageDriver();
      const driver = createDriver();
      const clientV1 = createClient({ schema: schemaV1, driver });
      const clientV2 = createClient({ schema: schemaV2, driver });

      await generate(clientV1, { storageDriver: storage, name: "init" });
      await generate(clientV2, { storageDriver: storage, name: "add-name" });
      await apply(clientV2, { storageDriver: storage });

      const result = await down(clientV2, {
        storageDriver: storage,
        to: "init",
      });
      expect(result.rolledBack.map((e) => e.name)).toEqual(["add-name"]);

      const statuses = await status(clientV2, { storageDriver: storage });
      expect(statuses.find((st) => st.entry.name === "init")?.applied).toBe(
        true
      );
      expect(statuses.find((st) => st.entry.name === "add-name")?.applied).toBe(
        false
      );
    });

    it("marks lossy operations with warnings in the down file", async () => {
      const storage = new MemoryStorageDriver();
      const driver = createDriver();
      const clientV2 = createClient({ schema: schemaV2, driver });
      const clientV1 = createClient({ schema: schemaV1, driver });

      await generate(clientV2, { storageDriver: storage, name: "init" });

      // Dropping the name column is lossy: down restores structure, not data
      const gen = await generate(clientV1, {
        storageDriver: storage,
        name: "drop-name",
      });
      expect(gen.entry).not.toBeNull();
      expect(gen.downWarnings.some((w) => w.includes("lossy"))).toBe(true);

      const downFile = await storage.readDownMigration(gen.entry!);
      expect(downFile).toContain("-- WARNING:");
    });
  });
}

runApplyDownRoundTrip("PGlite", createInMemoryPGliteDriver);
runApplyDownRoundTrip("SQLite3", createInMemorySQLite3Driver);
