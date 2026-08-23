/**
 * Migration Apply / Down Round-Trip Tests
 *
 * Generates up+down migrations for schema changes, applies them,
 * rolls them back, and asserts the schema round-trips.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { apply, down, generate, MigrationContext, status } from "@migrations";
import type { MigrationClient } from "@migrations/push";
import {
  formatMigrationFilename,
  MigrationStorageDriver,
} from "@migrations/storage";
import type { MigrationEntry } from "@migrations/types";
import { s } from "@schema";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it, vi } from "vitest";

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

const MISSING_DOWN_ARTIFACT = /has no down artifact/;
const EMPTY_DOWN_ARTIFACT = /empty down artifact/;
const IRREVERSIBLE_REASON = /cannot be reconstructed/;

const DOWN_PATH = (entry: MigrationEntry): string =>
  `meta/_down/${formatMigrationFilename(entry)}`;

/** Names of the migrations the tracking table currently claims are applied. */
async function trackedNames(
  client: MigrationClient,
  storage: MemoryStorageDriver
): Promise<string[]> {
  const statuses = await status(client, { storageDriver: storage });
  return statuses.filter((st) => st.applied).map((st) => st.entry.name);
}

async function tableExists(driver: AnyDriver, table: string): Promise<boolean> {
  try {
    await driver._executeRaw(`SELECT 1 FROM "${table}"`);
    return true;
  } catch {
    return false;
  }
}

async function columnExists(
  driver: AnyDriver,
  table: string,
  column: string
): Promise<boolean> {
  try {
    await driver._executeRaw(`SELECT "${column}" FROM "${table}"`);
    return true;
  } catch {
    return false;
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
    it(
      "generates up+down, applies, rolls back, and re-applies",
      { timeout: 30_000 },
      async () => {
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
        const down1 = await down(clientV2, {
          storageDriver: storage,
          steps: 1,
        });
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
        const down0 = await down(clientV1, {
          storageDriver: storage,
          steps: 1,
        });
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
      }
    );

    it(
      "rolls back to a specific migration with `to`",
      { timeout: 30_000 },
      async () => {
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
        expect(
          statuses.find((st) => st.entry.name === "add-name")?.applied
        ).toBe(false);
      }
    );

    it(
      "marks lossy operations with warnings in the down file",
      { timeout: 30_000 },
      async () => {
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
      }
    );

    it(
      "warns that reversing a created table drops it and every later row",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });

        const gen = await generate(clientV1, {
          storageDriver: storage,
          name: "init",
        });

        // Structurally exact, and destructive: reversing an added table (an
        // added polymorphic member among them) makes NO data-preservation
        // claim. Deliberately not worded "lossy" so it cannot be confused with
        // the dropTable/dropColumn warnings pinned above.
        expect(
          gen.downWarnings.some((w) => w.includes("inverts to dropTable"))
        ).toBe(true);
        expect(
          gen.downWarnings.some((w) => w.includes("No data is preserved."))
        ).toBe(true);
        expect(await storage.readDownMigration(gen.entry!)).toContain(
          "-- WARNING:"
        );
      }
    );

    it(
      "round-trips a manual migration's rollback SQL through storage",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await apply(clientV1, { storageDriver: storage });

        const manual = await generate(clientV1, {
          storageDriver: storage,
          name: "add-nickname-by-hand",
          manualMigration: {
            up: ['ALTER TABLE "user" ADD COLUMN "nickname" text;'],
            rollback: {
              kind: "manual",
              sql: ['ALTER TABLE "user" DROP COLUMN "nickname";'],
            },
          },
        });
        expect(manual.entry?.mode).toBe("manual");
        expect(manual.entry?.rollback).toEqual({ kind: "manual" });

        await apply(clientV1, { storageDriver: storage });
        expect(await columnExists(driver, "user", "nickname")).toBe(true);
        expect(await trackedNames(clientV1, storage)).toEqual([
          "init",
          "add-nickname-by-hand",
        ]);

        const rolled = await down(clientV1, {
          storageDriver: storage,
          steps: 1,
        });
        expect(rolled.rolledBack.map((e) => e.name)).toEqual([
          "add-nickname-by-hand",
        ]);

        // The caller's own rollback SQL ran, and only then did tracking change.
        expect(await columnExists(driver, "user", "nickname")).toBe(false);
        expect(await trackedNames(clientV1, storage)).toEqual(["init"]);
      }
    );

    it(
      "leaves schema AND tracking unchanged when a down statement fails",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await apply(clientV1, { storageDriver: storage });

        await generate(clientV1, {
          storageDriver: storage,
          name: "broken-rollback",
          manualMigration: {
            up: ['ALTER TABLE "user" ADD COLUMN "nickname" text;'],
            rollback: {
              kind: "manual",
              sql: ['DROP TABLE "table_that_does_not_exist";'],
            },
          },
        });
        await apply(clientV1, { storageDriver: storage });

        await expect(
          down(clientV1, { storageDriver: storage, steps: 1 })
        ).rejects.toThrow();

        // Execution precedes tracking inside one transaction, so a failed down
        // leaves both sides exactly as they were.
        expect(await columnExists(driver, "user", "nickname")).toBe(true);
        expect(await trackedNames(clientV1, storage)).toEqual([
          "init",
          "broken-rollback",
        ]);
      }
    );

    it(
      "refuses the WHOLE group when any down artifact is missing, empty or comment-only",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });
        const clientV2 = createClient({ schema: schemaV2, driver });

        const gen1 = await generate(clientV1, {
          storageDriver: storage,
          name: "init",
        });
        await generate(clientV2, {
          storageDriver: storage,
          name: "add-name",
        });
        await apply(clientV2, { storageDriver: storage });

        const downPath = DOWN_PATH(gen1.entry!);
        const original = storage.files.get(downPath);
        expect(original).toBeDefined();

        const cases: ReadonlyArray<{
          label: string;
          mutate: () => Promise<void>;
          message: RegExp;
        }> = [
          {
            label: "missing",
            mutate: () => storage.delete(downPath),
            message: MISSING_DOWN_ARTIFACT,
          },
          {
            label: "empty",
            mutate: () => storage.put(downPath, ""),
            message: EMPTY_DOWN_ARTIFACT,
          },
          {
            label: "comment-only",
            mutate: () =>
              storage.put(
                downPath,
                "-- Down migration for: init\n-- nothing to undo\n"
              ),
            message: EMPTY_DOWN_ARTIFACT,
          },
        ];

        for (const artifactCase of cases) {
          await artifactCase.mutate();

          // The preflight runs before the dry-run return, so the preview the
          // CLI confirms against reports the refusal too.
          await expect(
            down(clientV2, {
              storageDriver: storage,
              steps: 2,
              dryRun: true,
            })
          ).rejects.toThrow(artifactCase.message);
          await expect(
            down(clientV2, { storageDriver: storage, steps: 2 })
          ).rejects.toMatchObject({ code: "V11009" });

          // Group-wide and pre-effect: the LATER, perfectly reversible entry
          // neither ran nor lost its tracking row.
          expect(await columnExists(driver, "user", "name")).toBe(true);
          expect(await trackedNames(clientV2, storage)).toEqual([
            "init",
            "add-name",
          ]);

          await storage.put(downPath, original!);
        }

        // Restored, the same group rolls back end to end.
        const ok = await down(clientV2, { storageDriver: storage, steps: 2 });
        expect(ok.rolledBack.map((e) => e.name)).toEqual(["add-name", "init"]);
        expect(await tableExists(driver, "user")).toBe(false);
      }
    );

    it(
      "refuses a group containing an irreversible migration, quoting its reason",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await apply(clientV1, { storageDriver: storage });

        await generate(clientV1, {
          storageDriver: storage,
          name: "backfill-nicknames",
          manualMigration: {
            up: ['ALTER TABLE "user" ADD COLUMN "nickname" text;'],
            rollback: {
              kind: "irreversible",
              reason: "the backfilled nicknames cannot be reconstructed",
            },
          },
        });
        await apply(clientV1, { storageDriver: storage });

        // The reason is PERSISTED, not merely reported at generation time.
        expect(storage.files.get("meta/_journal.json")).toContain(
          '"kind": "irreversible"'
        );

        await expect(
          down(clientV1, { storageDriver: storage, steps: 2 })
        ).rejects.toThrow(IRREVERSIBLE_REASON);
        await expect(
          down(clientV1, { storageDriver: storage, steps: 2, dryRun: true })
        ).rejects.toMatchObject({ code: "V11009" });

        // Policy is checked before ANY artifact read and before the
        // transaction, so the earlier reversible entry is untouched.
        expect(await tableExists(driver, "user")).toBe(true);
        expect(await columnExists(driver, "user", "nickname")).toBe(true);
        expect(await trackedNames(clientV1, storage)).toEqual([
          "init",
          "backfill-nicknames",
        ]);
      }
    );

    it(
      "never executes a `-- down` marker tail from the up artifact",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });

        const gen = await generate(clientV1, {
          storageDriver: storage,
          name: "init",
        });
        await apply(clientV1, { storageDriver: storage });

        // A hand-authored up artifact may say anything. There is ONE down
        // source: meta/_down/. The marker tail is inert text.
        const upPath = formatMigrationFilename(gen.entry!);
        storage.files.set(
          upPath,
          `${storage.files.get(upPath)}\n-- down\nDROP TABLE "user";\n`
        );
        await storage.delete(DOWN_PATH(gen.entry!));

        await expect(
          down(clientV1, { storageDriver: storage, steps: 1 })
        ).rejects.toThrow(MISSING_DOWN_ARTIFACT);

        expect(await tableExists(driver, "user")).toBe(true);
        expect(await trackedNames(clientV1, storage)).toEqual(["init"]);
      }
    );

    it(
      "recomputes the rollback group from state read under the lock",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientV1 = createClient({ schema: schemaV1, driver });
        const clientV2 = createClient({ schema: schemaV2, driver });

        await generate(clientV1, { storageDriver: storage, name: "init" });
        await generate(clientV2, { storageDriver: storage, name: "add-name" });
        await apply(clientV2, { storageDriver: storage });

        // A concurrent process finishes its own rollback of `add-name` in the
        // window between this caller's request and lock acquisition.
        let fired = false;
        const acquire = MigrationContext.prototype.acquireLock;
        const spy = vi
          .spyOn(MigrationContext.prototype, "acquireLock")
          .mockImplementation(async function (this: MigrationContext) {
            await acquire.call(this);
            if (fired) return;
            fired = true;
            await down(clientV2, { storageDriver: storage, steps: 1 });
          });

        try {
          const result = await down(clientV2, {
            storageDriver: storage,
            steps: 1,
          });
          // The group is built from the state read INSIDE the lock: `add-name`
          // is already rolled back, so this rollback takes `init` instead of
          // re-running a down script whose effects are gone.
          expect(result.rolledBack.map((e) => e.name)).toEqual(["init"]);
        } finally {
          spy.mockRestore();
        }

        expect(await tableExists(driver, "user")).toBe(false);
        expect(await trackedNames(clientV2, storage)).toEqual([]);
      }
    );
  });
}

runApplyDownRoundTrip("PGlite", createInMemoryPGliteDriver);
runApplyDownRoundTrip("SQLite3", createInMemorySQLite3Driver);

/**
 * The polymorphic collection inverse cardinality is EXACTLY a uniqueness
 * constraint on the member junction's target column: inverse-one means one
 * membership per target row. Relaxing it to inverse-many is therefore a purely
 * structural drop — and reversing that drop is a claim about the rows that
 * exist NOW, which only the database can settle.
 */
function inverseOneSchemas() {
  const postOne = s.model({
    id: s.string().id(),
    galleryOwner: s
      .toOne(() => ownerOne)
      .name("gallery"),
  });
  const ownerOne = s.model({
    id: s.string().id(),
    gallery: s
      .toMany(
        { post: () => postOne },
        { values: { post: "gallery.post" } }
      )
      .name("gallery"),
  });

  // Same topology with the inverse-one declaration removed: one member
  // junction, no target-side unique constraint.
  const postMany = s.model({ id: s.string().id() });
  const ownerMany = s.model({
    id: s.string().id(),
    gallery: s
      .toMany(
        { post: () => postMany },
        { values: { post: "gallery.post" } }
      )
      .name("gallery"),
  });

  return {
    inverseOne: { post: postOne, owner: ownerOne },
    inverseMany: { post: postMany, owner: ownerMany },
  };
}

function runInverseOneUniquenessRollback(
  driverName: string,
  createDriver: () => AnyDriver
): void {
  describe(`reverse-one uniqueness rollback (${driverName})`, () => {
    it(
      "fails at the database when duplicate memberships exist, leaving schema and tracking unchanged",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const { inverseOne, inverseMany } = inverseOneSchemas();
        const clientOne = createClient({ schema: inverseOne, driver });
        const clientMany = createClient({ schema: inverseMany, driver });

        const init = await generate(clientOne, {
          storageDriver: storage,
          name: "init",
        });
        // Inverse-one IS the unique constraint on the target-side column.
        expect(init.sql.join("\n")).toContain(
          '"owner_gallery_post_postId_key"'
        );
        await apply(clientOne, { storageDriver: storage });

        await driver._executeRaw(`INSERT INTO "owner" ("id") VALUES ('o1')`);
        await driver._executeRaw(`INSERT INTO "owner" ("id") VALUES ('o2')`);
        await driver._executeRaw(`INSERT INTO "post" ("id") VALUES ('p1')`);
        await driver._executeRaw(
          `INSERT INTO "owner_gallery_post" ("ownerId", "postId") VALUES ('o1', 'p1')`
        );

        // A second membership for the same post is refused while inverse-one
        // holds.
        await expect(
          driver._executeRaw(
            `INSERT INTO "owner_gallery_post" ("ownerId", "postId") VALUES ('o2', 'p1')`
          )
        ).rejects.toThrow();

        // Relaxing to inverse-many is structural: the constraint drops.
        const relax = await generate(clientMany, {
          storageDriver: storage,
          name: "relax-inverse",
        });
        expect(relax.entry).not.toBeNull();
        await apply(clientMany, { storageDriver: storage });

        // Now the duplicate membership fits.
        await driver._executeRaw(
          `INSERT INTO "owner_gallery_post" ("ownerId", "postId") VALUES ('o2', 'p1')`
        );
        const rows = await driver._executeRaw(
          `SELECT "ownerId" FROM "owner_gallery_post" WHERE "postId" = 'p1'`
        );
        expect(rows.rows).toHaveLength(2);

        // Rolling back re-adds the constraint, which the live rows refuse.
        await expect(
          down(clientMany, { storageDriver: storage, steps: 1 })
        ).rejects.toThrow();

        // Neither the tracking row nor the data moved.
        expect(await trackedNames(clientMany, storage)).toEqual([
          "init",
          "relax-inverse",
        ]);
        const afterRows = await driver._executeRaw(
          `SELECT "ownerId" FROM "owner_gallery_post" WHERE "postId" = 'p1'`
        );
        expect(afterRows.rows).toHaveLength(2);

        // With the duplicate removed the same rollback succeeds, proving the
        // failure was the target-side fit and nothing else.
        await driver._executeRaw(
          `DELETE FROM "owner_gallery_post" WHERE "ownerId" = 'o2'`
        );
        const rolled = await down(clientMany, {
          storageDriver: storage,
          steps: 1,
        });
        expect(rolled.rolledBack.map((e) => e.name)).toEqual(["relax-inverse"]);
        expect(await trackedNames(clientMany, storage)).toEqual(["init"]);
      }
    );
  });
}

runInverseOneUniquenessRollback("PGlite", createInMemoryPGliteDriver);
runInverseOneUniquenessRollback("SQLite3", createInMemorySQLite3Driver);
