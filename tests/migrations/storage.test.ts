/**
 * Migration Storage Driver Tests
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationStorageDriver } from "../../src/migrations/storage";
import {
  createFsStorageDriver,
  FsStorageDriver,
} from "../../src/migrations/storage/fs";
import type {
  MigrationEntry,
  MigrationJournal,
  SchemaSnapshot,
} from "../../src/migrations/types";

// =============================================================================
// HELPERS
// =============================================================================

const TEST_DIR = join(__dirname, ".test-storage");

function makeEntry(idx: number, name: string): MigrationEntry {
  return {
    idx,
    version: "20240101000000",
    name,
    when: Date.now(),
    checksum: "abc123def456",
  };
}

function cleanupTestDir(): void {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true });
  }
}

// =============================================================================
// TESTS
// =============================================================================

describe("FsStorageDriver", () => {
  let driver: FsStorageDriver;

  beforeEach(() => {
    cleanupTestDir();
    driver = new FsStorageDriver(TEST_DIR);
  });

  afterEach(() => {
    cleanupTestDir();
  });

  it("should have correct driver name", () => {
    expect(driver.driverName).toBe("fs");
  });

  it("should have correct base directory", () => {
    expect(driver.baseDir).toBe(TEST_DIR);
  });
});

describe("createFsStorageDriver", () => {
  it("should create a FsStorageDriver instance", () => {
    const driver = createFsStorageDriver(TEST_DIR);
    expect(driver).toBeInstanceOf(FsStorageDriver);
    expect(driver).toBeInstanceOf(MigrationStorageDriver);
  });
});

describe("MigrationStorageDriver", () => {
  let storage: MigrationStorageDriver;

  beforeEach(() => {
    cleanupTestDir();
    storage = createFsStorageDriver(TEST_DIR);
  });

  afterEach(() => {
    cleanupTestDir();
  });

  describe("journal operations", () => {
    it("should return null when journal does not exist", async () => {
      const journal = await storage.readJournal();
      expect(journal).toBeNull();
    });

    it("should write and read journal", async () => {
      const journal: MigrationJournal = {
        version: "1",
        dialect: "postgresql",
        entries: [makeEntry(0, "initial")],
      };

      await storage.writeJournal(journal);
      const read = await storage.readJournal();

      expect(read).not.toBeNull();
      expect(read!.version).toBe("1");
      expect(read!.dialect).toBe("postgresql");
      expect(read!.entries).toHaveLength(1);
      expect(read!.entries[0].name).toBe("initial");
    });

    it("should get or create journal", async () => {
      // Should create new journal
      const journal = await storage.getOrCreateJournal("postgresql");
      expect(journal.dialect).toBe("postgresql");
      expect(journal.entries).toHaveLength(0);
    });

    it("should return existing journal with matching dialect", async () => {
      const journal: MigrationJournal = {
        version: "1",
        dialect: "postgresql",
        entries: [makeEntry(0, "existing")],
      };
      await storage.writeJournal(journal);

      const result = await storage.getOrCreateJournal("postgresql");
      expect(result.entries).toHaveLength(1);
      expect(result.entries[0].name).toBe("existing");
    });

    it("should throw on dialect mismatch", async () => {
      const journal: MigrationJournal = {
        version: "1",
        dialect: "postgresql",
        entries: [],
      };
      await storage.writeJournal(journal);

      await expect(storage.getOrCreateJournal("sqlite")).rejects.toThrow(
        "Journal dialect mismatch"
      );
    });
  });

  describe("snapshot operations", () => {
    it("should return null when snapshot does not exist", async () => {
      const snapshot = await storage.readSnapshot();
      expect(snapshot).toBeNull();
    });

    it("should write and read snapshot", async () => {
      const snapshot: SchemaSnapshot = {
        tables: [
          {
            name: "users",
            columns: [{ name: "id", type: "integer", nullable: false }],
            indexes: [],
            foreignKeys: [],
            uniqueConstraints: [],
          },
        ],
      };

      await storage.writeSnapshot(snapshot);
      const read = await storage.readSnapshot();

      expect(read).not.toBeNull();
      expect(read!.tables).toHaveLength(1);
      expect(read!.tables[0].name).toBe("users");
    });

    it("should return empty snapshot when none exists", async () => {
      const snapshot = await storage.getSnapshotOrEmpty();
      expect(snapshot.tables).toHaveLength(0);
    });
  });

  describe("migration file operations", () => {
    it("should write and read migration", async () => {
      const entry = makeEntry(0, "initial");
      const content = "CREATE TABLE users (id INT);";

      await storage.writeMigration(entry, content);
      const read = await storage.readMigration(entry);

      expect(read).toBe(content);
    });

    it("should return null for non-existent migration", async () => {
      const entry = makeEntry(99, "nonexistent");
      const read = await storage.readMigration(entry);
      expect(read).toBeNull();
    });

    it("should delete migration", async () => {
      const entry = makeEntry(0, "to-delete");
      await storage.writeMigration(entry, "content");
      expect(await storage.migrationExists(entry)).toBe(true);

      await storage.deleteMigration(entry);
      expect(await storage.migrationExists(entry)).toBe(false);
    });

    it("should check migration existence", async () => {
      const entry = makeEntry(0, "test");
      expect(await storage.migrationExists(entry)).toBe(false);

      await storage.writeMigration(entry, "content");
      expect(await storage.migrationExists(entry)).toBe(true);
    });
  });

  describe("down migration operations", () => {
    it("should write and read down migration", async () => {
      const entry = makeEntry(0, "initial");
      const content = "DROP TABLE users;";

      await storage.writeDownMigration(entry, content);
      const read = await storage.readDownMigration(entry);

      expect(read).toBe(content);
    });

    it("should return null for non-existent down migration", async () => {
      const entry = makeEntry(0, "no-down");
      const read = await storage.readDownMigration(entry);
      expect(read).toBeNull();
    });
  });

  describe("backup operations", () => {
    it("should backup migration", async () => {
      const entry = makeEntry(0, "to-backup");
      const content = "CREATE TABLE test;";
      await storage.writeMigration(entry, content);

      const backupPath = await storage.backupMigration(entry);

      expect(backupPath).not.toBeNull();
      expect(backupPath).toContain("_backup");
      expect(backupPath).toContain("0000_to-backup.sql");

      // Original should still exist
      expect(await storage.migrationExists(entry)).toBe(true);
    });

    it("should return null when backing up non-existent migration", async () => {
      const entry = makeEntry(99, "nonexistent");
      const backupPath = await storage.backupMigration(entry);
      expect(backupPath).toBeNull();
    });

    it("should archive migration (backup and delete)", async () => {
      const entry = makeEntry(0, "to-archive");
      await storage.writeMigration(entry, "content");

      const archivePath = await storage.archiveMigration(entry);

      expect(archivePath).not.toBeNull();
      expect(archivePath).toContain("_backup");
      // Original should be deleted
      expect(await storage.migrationExists(entry)).toBe(false);
    });

    it("should return null when archiving non-existent migration", async () => {
      const entry = makeEntry(99, "nonexistent");
      const archivePath = await storage.archiveMigration(entry);
      expect(archivePath).toBeNull();
    });
  });
});
