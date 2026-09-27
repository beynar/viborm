/**
 * Issue #42 on live PostgreSQL (PGlite): the constraint-dropping route stays
 * the way table removal works there.
 *
 * `materializeDroppedTableForeignKeys` removes every foreign key that touches a
 * dropped table before the first `DROP TABLE`, so nothing is left for
 * `orderTableDrops` to order and PostgreSQL accepts every orientation, a
 * populated cycle and a populated RESTRICT self-reference, none of which SQLite
 * can drop without rebuilding a table (`table-drop-order.test.ts`).
 *
 * One fresh database for the file: each cell creates its own tables, seeds
 * them, and removes all of them with an empty push through the public preview
 * and consent. The generated-migration cell uses its own database, so its
 * estate never meets the pushes.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { createMigrationClient } from "@src/migrations/client";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import type { ResolveCallback } from "@src/migrations/types";
import type { AnyModel } from "@src/schema/model";
import { afterAll, describe, expect, test } from "vitest";

type Schema = Record<string, AnyModel>;

const driver = new PGliteDriver();
afterAll(() => driver.disconnect());

const DROP_FOREIGN_KEY = /DROP CONSTRAINT/;
const DROP_TABLE = /^DROP TABLE /;

const proceed: ResolveCallback = (change) =>
  change.type === "destructive" ? change.proceed() : change.reject();

function migrationsFor(schema: Schema) {
  return createMigrationClient(createClient({ schema, driver }));
}

async function tables() {
  return (
    await driver._executeRaw<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`
    )
  ).rows.map((row) => row.tablename);
}

/** Removes everything through the preview's consent and reports what ran. */
async function removeAll() {
  const migrations = migrationsFor({});
  const preview = await migrations.push({ dryRun: true, resolve: proceed });
  const statements = preview.statements.map(({ sql }) => sql);
  const lastKeyDrop = statements
    .map((sql) => DROP_FOREIGN_KEY.test(sql))
    .lastIndexOf(true);
  const firstTableDrop = statements.findIndex((sql) => DROP_TABLE.test(sql));
  const applied = await migrations.push({ consent: preview.consent });
  return {
    keysBeforeTables: lastKeyDrop >= 0 && lastKeyDrop < firstTableDrop,
    outcome: applied.outcome,
    ranWhatWasShown:
      JSON.stringify(applied.statements) === JSON.stringify(preview.statements),
    remaining: await tables(),
  };
}

const REMOVED = {
  keysBeforeTables: true,
  outcome: "applied",
  ranWhatWasShown: true,
  remaining: [],
};

describe("PostgreSQL removes populated referencing tables in any shape", () => {
  for (const [parentName, childName] of [
    ["aaa_parent", "zzz_child"],
    ["zzz_parent", "aaa_child"],
  ] as const) {
    test(`${parentName} / ${childName}`, async () => {
      const parent = s
        .model({ id: s.string().id(), children: s.toMany(() => child) })
        .map(parentName);
      const child = s
        .model({
          id: s.string().id(),
          parentId: s.string(),
          parent: s
            .toOne(() => parent)
            .fields("parentId")
            .references("id")
            .onDelete("restrict"),
        })
        .map(childName);
      await migrationsFor({ parent, child }).push();
      await driver._executeRaw(
        `INSERT INTO "${parentName}" ("id") VALUES ('p1')`
      );
      await driver._executeRaw(
        `INSERT INTO "${childName}" ("id", "parentId") VALUES ('c1', 'p1')`
      );
      expect(await removeAll()).toEqual(REMOVED);
    });
  }

  test("a populated cycle", async () => {
    const west = s
      .model({
        id: s.string().id(),
        eastId: s.string().nullable(),
        east: s
          .toOne(() => east)
          .name("pick")
          .fields("eastId")
          .references("id")
          .onDelete("restrict"),
        pickedBy: s.toMany(() => east).name("back"),
      })
      .map("a_west");
    const east = s
      .model({
        id: s.string().id(),
        westId: s.string().nullable(),
        west: s
          .toOne(() => west)
          .name("back")
          .fields("westId")
          .references("id")
          .onDelete("restrict"),
        pickedBy: s.toMany(() => west).name("pick"),
      })
      .map("b_east");
    await migrationsFor({ west, east }).push();
    await driver._executeRaw(
      `INSERT INTO "a_west" ("id", "eastId") VALUES ('w', NULL)`
    );
    await driver._executeRaw(
      `INSERT INTO "b_east" ("id", "westId") VALUES ('e', 'w')`
    );
    await driver._executeRaw(`UPDATE "a_west" SET "eastId" = 'e'`);
    expect(await removeAll()).toEqual(REMOVED);
  });

  test("a populated RESTRICT self-reference", async () => {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .name("tree")
        .fields("parentId")
        .references("id")
        .onDelete("restrict"),
      children: s.toMany(() => node).name("tree"),
    });
    await migrationsFor({ node }).push();
    await driver._executeRaw(
      `INSERT INTO "node" ("id", "parentId") VALUES ('root', NULL), ('kid', 'root')`
    );
    expect(await removeAll()).toEqual(REMOVED);
  });
});

test("a generated parent and child drop applies, and its rollback recreates both tables before their key", async () => {
  const own = new PGliteDriver();
  const storage = new MemoryEstateStorage();
  const parent = s
    .model({ id: s.string().id(), children: s.toMany(() => child) })
    .map("aaa_parent");
  const child = s
    .model({
      id: s.string().id(),
      parentId: s.string(),
      parent: s
        .toOne(() => parent)
        .fields("parentId")
        .references("id")
        .onDelete("restrict"),
    })
    .map("zzz_child");
  const full = createMigrationClient(
    createClient({ schema: { parent, child }, driver: own }),
    { storage }
  );
  await full.generate({ name: "init" });
  await full.apply();
  await own._executeRaw(`INSERT INTO "aaa_parent" ("id") VALUES ('p1')`);
  await own._executeRaw(
    `INSERT INTO "zzz_child" ("id", "parentId") VALUES ('c1', 'p1')`
  );
  const empty = createMigrationClient(
    createClient({ schema: {}, driver: own }),
    {
      storage,
    }
  );
  await empty.generate({ name: "drop", resolve: proceed });
  expect((await empty.apply()).outcome).toBe("applied");

  await empty.down();
  const restored = await own._executeRaw<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename IN ('aaa_parent', 'zzz_child') ORDER BY tablename`
  );
  expect(restored.rows.map((row) => row.tablename)).toEqual([
    "aaa_parent",
    "zzz_child",
  ]);
  const keys = await own._executeRaw<{ conname: string }>(
    `SELECT conname FROM pg_constraint WHERE contype = 'f' AND conrelid = '"zzz_child"'::regclass`
  );
  expect(keys.rows.map((row) => row.conname)).toEqual([
    "zzz_child_parentId_fkey",
  ]);
  // The restored key is enforced; the rows are gone, as the rollback warns.
  await expect(
    own._executeRaw(
      `INSERT INTO "zzz_child" ("id", "parentId") VALUES ('c2', 'missing')`
    )
  ).rejects.toThrow();
  await own.disconnect();
});
