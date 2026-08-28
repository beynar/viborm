/**
 * Manual Migration Artifact — Live Round Trips
 *
 * A polymorphic cardinality flip moves membership between owner-row columns and
 * member junction tables. Generation will not invent that data movement; the
 * caller owns it through `GenerateOptions.manualMigration` as Sql values.
 *
 * These tests execute the caller's artifact against a real database and then
 * query the rows. Nothing here is proven by string matching: the ordering
 * inside the artifact (create destination -> copy membership -> remove source)
 * is proven by the fact that the statements SUCCEED in that order and the rows
 * land where they must.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import { sql } from "@sql";
import { createInMemoryPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { describe, expect, it } from "vitest";
import { MemoryStorage } from "./_estate";

const IRREVERSIBLE_REASON = /cannot be reconstructed/;
const STORED_POST = "content.post.v1";

function toOneSchema() {
  const post = s.model({ id: s.string().id(), body: s.string() });
  const content = s.model({
    id: s.string().id(),
    subject: s
      .toOne({ post: () => post }, { values: { post: STORED_POST } })
      .optional(),
  });
  return { post, content };
}

function toManySchema() {
  const post = s.model({ id: s.string().id(), body: s.string() });
  const content = s.model({
    id: s.string().id(),
    subject: s.toMany({ post: () => post }, { values: { post: STORED_POST } }),
  });
  return { post, content };
}

const TO_MANY_UP = [
  sql.raw(`CREATE TABLE "content_subject_post" (
  "contentId" text NOT NULL,
  "postId" text NOT NULL,
  PRIMARY KEY ("contentId", "postId"),
  CONSTRAINT "content_subject_post_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "content" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "content_subject_post_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post" ("id") ON DELETE CASCADE ON UPDATE CASCADE
)`),
  sql.raw(
    `CREATE INDEX "content_subject_post_postId_idx" ON "content_subject_post" ("postId")`
  ),
  sql.raw(
    `INSERT INTO "content_subject_post" ("contentId", "postId") SELECT "id", "subject_id" FROM "content" WHERE "subject_type" = '${STORED_POST}' AND "subject_id" IS NOT NULL`
  ),
  sql.raw(`DROP INDEX "content_subject_poly_idx"`),
  sql.raw(`ALTER TABLE "content" DROP COLUMN "subject_type"`),
  sql.raw(`ALTER TABLE "content" DROP COLUMN "subject_id"`),
];

const TO_ONE_UP = [
  sql.raw(`ALTER TABLE "content" ADD COLUMN "subject_type" text`),
  sql.raw(`ALTER TABLE "content" ADD COLUMN "subject_id" text`),
  sql.raw(
    `CREATE INDEX "content_subject_poly_idx" ON "content" ("subject_type", "subject_id")`
  ),
  sql.raw(
    `UPDATE "content" SET "subject_type" = '${STORED_POST}', "subject_id" = (SELECT MIN(j."postId") FROM "content_subject_post" j WHERE j."contentId" = "content"."id") WHERE EXISTS (SELECT 1 FROM "content_subject_post" k WHERE k."contentId" = "content"."id")`
  ),
  sql.raw(`DROP TABLE "content_subject_post"`),
];

async function appliedNames(
  migrations: ReturnType<typeof createMigrationClient>
): Promise<string[]> {
  const report = await migrations.status();
  if (!report.marker) return [];
  const listed = await migrations.list();
  const byId = new Map(listed.map((state) => [state.stateId, state.name]));
  return report.marker.path
    .map((edge) => byId.get(edge.stateId))
    .filter((name): name is string => name !== undefined);
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
        const storage = new MemoryStorage();
        const driver = createDriver();
        const clientOne = createClient({ schema: toOneSchema(), driver });
        const clientMany = createClient({ schema: toManySchema(), driver });
        const one = createMigrationClient(clientOne, { storage });
        const many = createMigrationClient(clientMany, { storage });

        const init = await one.generate({ name: "init" });
        await one.apply();

        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p1', 'first')`
        );
        await driver._executeRaw(
          `INSERT INTO "content" ("id", "subject_type", "subject_id") VALUES ('c1', '${STORED_POST}', 'p1')`
        );
        await driver._executeRaw(
          `INSERT INTO "content" ("id", "subject_type", "subject_id") VALUES ('c2', NULL, NULL)`
        );

        storage.writes.length = 0;
        const manual = await many.generate({
          name: "subject-to-many",
          from: init.stateId,
          manualMigration: {
            transitions: [
              {
                from: init.stateId,
                execution: "transactional",
                up: TO_MANY_UP,
                rollback: {
                  kind: "manual",
                  execution: "transactional",
                  sql: TO_ONE_UP,
                },
              },
            ],
          },
        });
        expect(manual.outcome).toBe("published");
        expect(manual.stateId).not.toBeNull();

        await many.apply();

        const memberships = await driver._executeRaw(
          `SELECT "contentId", "postId" FROM "content_subject_post" ORDER BY "contentId"`
        );
        expect(memberships.rows).toEqual([{ contentId: "c1", postId: "p1" }]);

        await expect(
          driver._executeRaw(`SELECT "subject_type" FROM "content"`)
        ).rejects.toThrow();
        const owners = await driver._executeRaw(
          `SELECT "id" FROM "content" ORDER BY "id"`
        );
        expect(owners.rows).toHaveLength(2);

        const rolled = await many.down({ steps: 1 });
        expect(rolled.path).toHaveLength(1);
        const restored = await driver._executeRaw(
          `SELECT "id", "subject_type", "subject_id" FROM "content" ORDER BY "id"`
        );
        expect(restored.rows).toEqual([
          { id: "c1", subject_type: STORED_POST, subject_id: "p1" },
          { id: "c2", subject_type: null, subject_id: null },
        ]);
        expect(await appliedNames(many)).toEqual(["init"]);
      }
    );

    it(
      "toMany -> toOne: chooses one membership per owner BEFORE populating row-held storage",
      { timeout: 30_000 },
      async () => {
        const storage = new MemoryStorage();
        const driver = createDriver();
        const clientMany = createClient({ schema: toManySchema(), driver });
        const clientOne = createClient({ schema: toOneSchema(), driver });
        const many = createMigrationClient(clientMany, { storage });
        const one = createMigrationClient(clientOne, { storage });

        const init = await many.generate({ name: "init" });
        await many.apply();

        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p1', 'first')`
        );
        await driver._executeRaw(
          `INSERT INTO "post" ("id", "body") VALUES ('p2', 'second')`
        );
        await driver._executeRaw(`INSERT INTO "content" ("id") VALUES ('c1')`);
        await driver._executeRaw(`INSERT INTO "content" ("id") VALUES ('c2')`);
        await driver._executeRaw(
          `INSERT INTO "content_subject_post" ("contentId", "postId") VALUES ('c1', 'p1')`
        );
        await driver._executeRaw(
          `INSERT INTO "content_subject_post" ("contentId", "postId") VALUES ('c1', 'p2')`
        );

        await one.generate({
          name: "subject-to-one",
          from: init.stateId,
          manualMigration: {
            transitions: [
              {
                from: init.stateId,
                execution: "transactional",
                up: TO_ONE_UP,
                rollback: {
                  kind: "irreversible",
                  reason:
                    "the memberships this migration discards cannot be reconstructed",
                },
              },
            ],
          },
        });
        await one.apply();

        const rows = await driver._executeRaw(
          `SELECT "id", "subject_type", "subject_id" FROM "content" ORDER BY "id"`
        );
        expect(rows.rows).toEqual([
          { id: "c1", subject_type: STORED_POST, subject_id: "p1" },
          { id: "c2", subject_type: null, subject_id: null },
        ]);

        await expect(
          driver._executeRaw(`SELECT 1 FROM "content_subject_post"`)
        ).rejects.toThrow();

        await expect(one.down({ steps: 1 })).rejects.toThrow(
          IRREVERSIBLE_REASON
        );
        expect(await appliedNames(one)).toEqual(["init", "subject-to-one"]);
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
