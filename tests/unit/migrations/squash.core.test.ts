/**
 * Migration Squash
 *
 * Squash composes generated migrations into one. Every assertion below is an
 * observable outcome: recorded storage writes, tracking rows, and the schema a
 * live database reports after the composed artifacts run.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import {
  apply,
  down,
  generate,
  introspect,
  type MigrationStatus,
  squash,
  status,
} from "@migrations";
import type { MigrationClient } from "@migrations/push";
import { MigrationStorageDriver } from "@migrations/storage";
import { s } from "@schema";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";

class MemoryStorageDriver extends MigrationStorageDriver {
  readonly files = new Map<string, string>();
  readonly writes: string[] = [];

  constructor() {
    super("memory");
  }

  get(path: string): Promise<string | null> {
    return Promise.resolve(this.files.get(path) ?? null);
  }

  put(path: string, content: string): Promise<void> {
    this.files.set(path, content);
    this.writes.push(path);
    return Promise.resolve();
  }

  delete(path: string): Promise<void> {
    this.files.delete(path);
    return Promise.resolve();
  }
}

const MIXED_RANGE = /mixes applied and pending/;
const NOT_A_SUFFIX = /is not a suffix of the journal/;
const MISSING_DOWN_ARTIFACT = /has no down artifact/;
const MANUAL_SOURCE = /is manual with rollback policy "manual"/;
const IRREVERSIBLE_SOURCE = /is manual with rollback policy "irreversible"/;

const schemaV1 = {
  user: s.model({ id: s.string().id(), email: s.string().unique() }),
};

const schemaV2 = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
  }),
};

const schemaV3 = {
  user: s.model({
    id: s.string().id(),
    email: s.string().unique(),
    name: s.string().nullable(),
  }),
  post: s.model({ id: s.string().id(), title: s.string() }),
};

/** The schema the database actually reports, minus migration bookkeeping. */
async function liveTables(
  client: MigrationClient
): Promise<Array<{ name: string; columns: string[] }>> {
  const snapshot = await introspect(client);
  return snapshot.tables
    .filter((table) => !table.name.startsWith("_viborm"))
    .map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => column.name).sort(),
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

async function trackingState(
  client: MigrationClient,
  storage: MemoryStorageDriver
): Promise<Array<{ name: string; applied: boolean }>> {
  const statuses: MigrationStatus[] = await status(client, {
    storageDriver: storage,
  });
  return statuses.map((st) => ({ name: st.entry.name, applied: st.applied }));
}

function runSquashSuite(driverName: string, createDriver: () => AnyDriver) {
  describe(`squash (${driverName})`, () => {
    it(
      "composes a reversible migration whose down restores the pre-squash schema",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });
        const clientV2 = createClient({ schema: schemaV2, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await generate(clientV2, { storageDriver: storage, name: "add-name" });

        const before = await liveTables(clientV2);
        expect(before).toEqual([]);

        const result = await squash(clientV2, {
          storageDriver: storage,
          name: "squashed",
        });

        expect(result.squashedCount).toBe(2);
        expect(result.entry.idx).toBe(0);
        expect(result.entry.mode).toBe("generated");
        expect(result.entry.rollback).toEqual({ kind: "automatic" });

        // A squashed migration is only useful if it can be rolled back: the
        // composed down is non-empty and lands in the ordinary artifact.
        expect(result.downSql.length).toBeGreaterThan(0);
        const downArtifact = await storage.readDownMigration(result.entry);
        expect(downArtifact).not.toBeNull();
        expect(downArtifact).toContain("DROP TABLE");

        const journal = await storage.readJournal();
        expect(journal?.entries.map((e) => [e.idx, e.name])).toEqual([
          [0, "squashed"],
        ]);

        // The composed up creates the final schema...
        await apply(clientV2, { storageDriver: storage });
        expect(await liveTables(clientV2)).toEqual([
          { name: "user", columns: ["email", "id", "name"] },
        ]);

        // ...and the composed down reverses the sources in REVERSE order. In
        // forward order the first statement would drop the table the rest of
        // the script still operates on, so a successful rollback is the proof.
        const rolled = await down(clientV2, {
          storageDriver: storage,
          steps: 1,
        });
        expect(rolled.rolledBack.map((e) => e.name)).toEqual(["squashed"]);
        expect(await liveTables(clientV2)).toEqual(before);
      }
    );

    it(
      "refuses a mixed applied/pending range before any write, and both uniform controls succeed",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });
        const clientV2 = createClient({ schema: schemaV2, driver });
        const clientV3 = createClient({ schema: schemaV3, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await generate(clientV2, { storageDriver: storage, name: "add-name" });
        await generate(clientV3, { storageDriver: storage, name: "add-post" });

        // Only the first migration is applied: the range is mixed.
        await apply(clientV3, { storageDriver: storage, to: 0 });
        const trackingBefore = await trackingState(clientV3, storage);
        const schemaBefore = await liveTables(clientV3);
        storage.writes.length = 0;

        await expect(
          squash(clientV3, { storageDriver: storage, name: "mixed" })
        ).rejects.toThrow(MIXED_RANGE);
        await expect(
          squash(clientV3, { storageDriver: storage, name: "mixed" })
        ).rejects.toMatchObject({ code: "V11009" });

        // Pre-effect: no migration, journal, snapshot or down artifact written,
        // no tracking row moved, no DDL run.
        expect(storage.writes).toEqual([]);
        expect(await trackingState(clientV3, storage)).toEqual(trackingBefore);
        expect(await liveTables(clientV3)).toEqual(schemaBefore);
        expect((await storage.readJournal())?.entries).toHaveLength(3);

        // Control 1 — all applied: the squashed entry replaces the source
        // tracking rows and the schema is untouched.
        await apply(clientV3, { storageDriver: storage });
        const appliedSchema = await liveTables(clientV3);
        await squash(clientV3, { storageDriver: storage, name: "all-applied" });
        expect(await trackingState(clientV3, storage)).toEqual([
          { name: "all-applied", applied: true },
        ]);
        expect(await liveTables(clientV3)).toEqual(appliedSchema);

        // Control 2 — all pending: a fresh estate squashes with no tracking
        // mutation at all.
        const pendingStorage = new MemoryStorageDriver();
        const pendingDriver = createDriver();
        const pendingV1 = createClient({
          schema: schemaV1,
          driver: pendingDriver,
        });
        const pendingV2 = createClient({
          schema: schemaV2,
          driver: pendingDriver,
        });
        await generate(pendingV1, {
          storageDriver: pendingStorage,
          name: "init",
        });
        await generate(pendingV2, {
          storageDriver: pendingStorage,
          name: "add-name",
        });
        await squash(pendingV2, {
          storageDriver: pendingStorage,
          name: "all-pending",
        });
        expect(await trackingState(pendingV2, pendingStorage)).toEqual([
          { name: "all-pending", applied: false },
        ]);
        expect(await liveTables(pendingV2)).toEqual([]);
      }
    );

    it(
      "refuses a manual or irreversible source before any write",
      { timeout: 30_000 },
      async () => {
        for (const policyCase of [
          {
            label: "manual",
            rollback: {
              kind: "manual" as const,
              sql: ['ALTER TABLE "user" DROP COLUMN "nickname";'],
            },
            message: MANUAL_SOURCE,
          },
          {
            label: "irreversible",
            rollback: {
              kind: "irreversible" as const,
              reason: "the backfill cannot be undone",
            },
            message: IRREVERSIBLE_SOURCE,
          },
        ]) {
          const storage = new MemoryStorageDriver();
          const driver = createDriver();
          const clientV1 = createClient({ schema: schemaV1, driver });

          await generate(clientV1, { storageDriver: storage, name: "init" });
          await generate(clientV1, {
            storageDriver: storage,
            name: `hand-written-${policyCase.label}`,
            manualMigration: {
              up: ['ALTER TABLE "user" ADD COLUMN "nickname" text;'],
              rollback: policyCase.rollback,
            },
          });
          storage.writes.length = 0;

          await expect(
            squash(clientV1, { storageDriver: storage, name: "squashed" })
          ).rejects.toThrow(policyCase.message);
          await expect(
            squash(clientV1, {
              storageDriver: storage,
              name: "squashed",
              dryRun: true,
            })
          ).rejects.toMatchObject({ code: "V11009" });

          expect(storage.writes).toEqual([]);
          expect((await storage.readJournal())?.entries).toHaveLength(2);
        }
      }
    );

    it(
      "refuses a non-suffix range and a source with no down artifact, before any write",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });
        const clientV2 = createClient({ schema: schemaV2, driver });
        const clientV3 = createClient({ schema: schemaV3, driver });

        const init = await generate(clientV1, {
          storageDriver: storage,
          name: "init",
        });
        await generate(clientV2, { storageDriver: storage, name: "add-name" });
        await generate(clientV3, { storageDriver: storage, name: "add-post" });
        storage.writes.length = 0;

        // A prefix squash would re-index the later entries without renaming
        // their artifacts, orphaning every one of them.
        await expect(
          squash(clientV3, { storageDriver: storage, from: 0, to: 1 })
        ).rejects.toThrow(NOT_A_SUFFIX);
        expect(storage.writes).toEqual([]);

        // A source whose down artifact is gone cannot be composed into a
        // reversible squash.
        await storage.delete(`meta/_down/0000_${init.entry!.name}.sql`);
        await expect(
          squash(clientV3, { storageDriver: storage, name: "squashed" })
        ).rejects.toThrow(MISSING_DOWN_ARTIFACT);
        expect(storage.writes).toEqual([]);
        expect((await storage.readJournal())?.entries).toHaveLength(3);
      }
    );
  });
}

runSquashSuite("PGlite", createInMemoryPGliteDriver);
runSquashSuite("SQLite3", createInMemorySQLite3Driver);
