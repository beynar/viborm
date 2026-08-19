/**
 * Manual Migration Artifact — Live Round Trips
 *
 * A polymorphic cardinality flip moves membership between owner-row columns and
 * member junction tables. Generation refuses to invent that data movement; the
 * caller owns it through `GenerateOptions.manualMigration`.
 *
 * These tests execute the caller's artifact against a real database and then
 * query the rows. Nothing here is proven by string matching: the ordering
 * inside the artifact (create destination -> copy membership -> remove source)
 * is proven by the fact that the statements SUCCEED in that order and the rows
 * land where they must.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { apply, down, generate, status } from "@migrations";
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

const IRREVERSIBLE_REASON = /cannot be reconstructed/;
const STORED_POST = "content.post.v1";

/** To-one: membership lives in two owner-row columns plus a pair index. */
function toOneSchema() {
  const post = s.model({ id: s.string().id(), body: s.string() });
  const content = s.model({
    id: s.string().id(),
    subject: s
      .polymorphicToOne({ post: () => post }, { values: { post: STORED_POST } })
      .optional(),
  });
  return { post, content };
}

/** Collection: membership lives in one member junction table per variant. */
function toManySchema() {
  const post = s.model({ id: s.string().id(), body: s.string() });
  const content = s.model({
    id: s.string().id(),
    subject: s.polymorphicToMany(
      { post: () => post },
      { values: { post: STORED_POST } }
    ),
  });
  return { post, content };
}

/**
 * Create destination, copy membership, THEN remove the source. Every statement
 * depends on the previous one having run: the copy reads columns the last two
 * statements delete, and the columns cannot be dropped while the pair index
 * still covers them.
 */
const TO_MANY_UP = [
  `CREATE TABLE "content_subject_post" (
  "contentId" text NOT NULL,
  "postId" text NOT NULL,
  PRIMARY KEY ("contentId", "postId"),
  CONSTRAINT "content_subject_post_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "content" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "content_subject_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);`,
  `CREATE INDEX "content_subject_post_postId_idx" ON "content_subject_post" ("postId");`,
  `INSERT INTO "content_subject_post" ("contentId", "postId") SELECT "id", "subject_id" FROM "content" WHERE "subject_type" = '${STORED_POST}' AND "subject_id" IS NOT NULL;`,
  `DROP INDEX "content_subject_poly_idx";`,
  `ALTER TABLE "content" DROP COLUMN "subject_type";`,
  `ALTER TABLE "content" DROP COLUMN "subject_id";`,
];

/**
 * The reverse direction cannot copy: row-held storage holds ONE membership per
 * owner, so the artifact must CHOOSE which membership survives (here the
 * lowest post id) and it must choose before it drops the junction.
 */
const TO_ONE_UP = [
  `ALTER TABLE "content" ADD COLUMN "subject_type" text;`,
  `ALTER TABLE "content" ADD COLUMN "subject_id" text;`,
  `CREATE INDEX "content_subject_poly_idx" ON "content" ("subject_type", "subject_id");`,
  `UPDATE "content" SET "subject_type" = '${STORED_POST}', "subject_id" = (SELECT MIN(j."postId") FROM "content_subject_post" j WHERE j."contentId" = "content"."id") WHERE EXISTS (SELECT 1 FROM "content_subject_post" k WHERE k."contentId" = "content"."id");`,
  `DROP TABLE "content_subject_post";`,
];

async function appliedNames(
  client: Parameters<typeof status>[0],
  storage: MemoryStorageDriver
): Promise<string[]> {
  const statuses = await status(client, { storageDriver: storage });
  return statuses.filter((st) => st.applied).map((st) => st.entry.name);
}

function runManualCardinalityFlips(
  driverName: string,
  createDriver: () => AnyDriver
): void {
  describe(`manual polymorphic cardinality flip (${driverName})`, () => {
    it(
      "toOne -> toMany: creates the destination, copies membership, drops the source columns",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientOne = createClient({ schema: toOneSchema(), driver });
        const clientMany = createClient({ schema: toManySchema(), driver });

        await generate(clientOne, { storageDriver: storage, name: "init" });
        await apply(clientOne, { storageDriver: storage });

        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p1', 'first')`
        );
        await driver._executeRaw(
          `INSERT INTO "content" ("id", "subject_type", "subject_id") VALUES ('c1', '${STORED_POST}', 'p1')`
        );
        await driver._executeRaw(
          `INSERT INTO "content" ("id", "subject_type", "subject_id") VALUES ('c2', NULL, NULL)`
        );

        // Without the artifact the flip refuses outright, writing nothing.
        storage.writes.length = 0;
        await expect(
          generate(clientMany, { storageDriver: storage, name: "to-many" })
        ).rejects.toMatchObject({ code: "V11010" });
        expect(storage.writes).toEqual([]);

        const manual = await generate(clientMany, {
          storageDriver: storage,
          name: "subject-to-many",
          manualMigration: {
            up: TO_MANY_UP,
            rollback: { kind: "manual", sql: TO_ONE_UP },
          },
        });
        expect(manual.entry?.mode).toBe("manual");
        expect(manual.sql).toEqual(TO_MANY_UP);

        await apply(clientMany, { storageDriver: storage });

        // The destination holds the membership that used to live in the row.
        const memberships = await driver._executeRaw(
          `SELECT "contentId", "postId" FROM "content_subject_post" ORDER BY "contentId"`
        );
        expect(memberships.rows).toEqual([{ contentId: "c1", postId: "p1" }]);

        // The source columns are gone — the copy necessarily preceded them.
        await expect(
          driver._executeRaw(`SELECT "subject_type" FROM "content"`)
        ).rejects.toThrow();
        const owners = await driver._executeRaw(
          `SELECT "id" FROM "content" ORDER BY "id"`
        );
        expect(owners.rows).toHaveLength(2);

        // The caller's rollback puts the membership back in the owner row.
        const rolled = await down(clientMany, {
          storageDriver: storage,
          steps: 1,
        });
        expect(rolled.rolledBack.map((e) => e.name)).toEqual([
          "subject-to-many",
        ]);
        const restored = await driver._executeRaw(
          `SELECT "id", "subject_type", "subject_id" FROM "content" ORDER BY "id"`
        );
        expect(restored.rows).toEqual([
          { id: "c1", subject_type: STORED_POST, subject_id: "p1" },
          { id: "c2", subject_type: null, subject_id: null },
        ]);
        expect(await appliedNames(clientMany, storage)).toEqual(["init"]);
      }
    );

    it(
      "toMany -> toOne: chooses one membership per owner BEFORE populating row-held storage",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorageDriver();
        const driver = createDriver();
        const clientMany = createClient({ schema: toManySchema(), driver });
        const clientOne = createClient({ schema: toOneSchema(), driver });

        await generate(clientMany, { storageDriver: storage, name: "init" });
        await apply(clientMany, { storageDriver: storage });

        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p1', 'first')`
        );
        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p2', 'second')`
        );
        await driver._executeRaw(`INSERT INTO "content" ("id") VALUES ('c1')`);
        await driver._executeRaw(`INSERT INTO "content" ("id") VALUES ('c2')`);
        // c1 holds TWO memberships: row-held storage can keep only one.
        await driver._executeRaw(
          `INSERT INTO "content_subject_post" ("contentId", "postId") VALUES ('c1', 'p1')`
        );
        await driver._executeRaw(
          `INSERT INTO "content_subject_post" ("contentId", "postId") VALUES ('c1', 'p2')`
        );

        storage.writes.length = 0;
        await expect(
          generate(clientOne, { storageDriver: storage, name: "to-one" })
        ).rejects.toMatchObject({ code: "V11010" });
        expect(storage.writes).toEqual([]);

        await generate(clientOne, {
          storageDriver: storage,
          name: "subject-to-one",
          manualMigration: {
            up: TO_ONE_UP,
            rollback: {
              kind: "irreversible",
              reason:
                "the memberships this migration discards cannot be reconstructed",
            },
          },
        });
        await apply(clientOne, { storageDriver: storage });

        // Exactly one membership per owner survived, and it is the one the
        // artifact chose.
        const rows = await driver._executeRaw(
          `SELECT "id", "subject_type", "subject_id" FROM "content" ORDER BY "id"`
        );
        expect(rows.rows).toEqual([
          { id: "c1", subject_type: STORED_POST, subject_id: "p1" },
          { id: "c2", subject_type: null, subject_id: null },
        ]);

        // The source is gone: the choice necessarily preceded the drop.
        await expect(
          driver._executeRaw(`SELECT 1 FROM "content_subject_post"`)
        ).rejects.toThrow();

        // An irreversible migration refuses to roll back, quoting its reason,
        // and leaves the estate exactly as it is.
        await expect(
          down(clientOne, { storageDriver: storage, steps: 1 })
        ).rejects.toThrow(IRREVERSIBLE_REASON);
        expect(await appliedNames(clientOne, storage)).toEqual([
          "init",
          "subject-to-one",
        ]);
        const afterRefusal = await driver._executeRaw(
          `SELECT "subject_id" FROM "content" WHERE "id" = 'c1'`
        );
        expect(afterRefusal.rows).toEqual([{ subject_id: "p1" }]);
      }
    );
  });
}

runManualCardinalityFlips("PGlite", createInMemoryPGliteDriver);
runManualCardinalityFlips("SQLite3", createInMemorySQLite3Driver);
