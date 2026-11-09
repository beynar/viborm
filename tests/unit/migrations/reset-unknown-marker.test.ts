/**
 * `reset()` on a database whose marker names a state this estate does not
 * hold: the estate was replaced by a fresh history (a new root, no shared
 * states) and the database still carries the old one's marker
 * (`status().markerState === "unknown"`). `reanchor()` refuses when the
 * schemas differ; `reset()` is the command that clears and replays, and its
 * dry run and its effectful run must agree. In 1.4.2 the dry run returned a
 * plan and the effectful run refused with MIGRATION_CORRUPTION, asking the
 * estate for the marker's own snapshot (Pyxel, viborm 1.4.2 upgrade).
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, expect, test } from "vitest";

const legacy = s.model({ id: s.string().id(), email: s.string().unique() });
const current = s.model({
  id: s.string().id(),
  title: s.string(),
  views: s.int().default(0),
});

const open: { disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.disconnect();
});

/** A database applied by estate A, and a client on a fresh estate B. */
async function replacedHistory() {
  const driver = createInMemorySQLite3Driver();
  open.push(driver);
  const estateA = new MemoryEstateStorage();
  const onA = createMigrationClient(
    createClient({ schema: { legacy }, driver }),
    { storage: estateA }
  );
  await onA.generate({ name: "a-root" });
  await onA.apply();
  await driver._executeRaw(
    `INSERT INTO "legacy" ("id", "email") VALUES ('1', 'a@b')`
  );
  const estateB = new MemoryEstateStorage();
  const onB = createMigrationClient(
    createClient({ schema: { current }, driver }),
    { storage: estateB }
  );
  const root = await onB.generate({ name: "b-root" });
  const tables = async () =>
    (
      await driver._executeRaw<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_viborm%' AND name NOT LIKE 'sqlite_%' ORDER BY name`
      )
    ).rows.map((row) => row.name);
  return { driver, onB, root: root.stateId!, tables };
}

test("the marker is unknown to the new estate and reanchor refuses", async () => {
  const { onB } = await replacedHistory();
  expect((await onB.status()).markerState).toBe("unknown");
  await expect(onB.reanchor()).rejects.toMatchObject({
    code: VibORMErrorCode.MIGRATION_DRIFT,
  });
});

test("reset's dry run and its run agree: both clear and replay the new estate", async () => {
  const { onB, root, tables } = await replacedHistory();
  const preview = await onB.reset({ dryRun: true });
  expect(preview).toMatchObject({ preview: true, path: [root] });
  expect(preview.tables).toEqual(["legacy"]);
  expect(await tables()).toEqual(["legacy"]);

  const run = await onB.reset();
  expect(run).toEqual({ preview: false, path: [root] });
  expect(await tables()).toEqual(["current"]);
  const status = await onB.status();
  expect(status.markerState).toBeUndefined();
  expect(status.marker?.stateId).toBe(root);
  expect(status.pending).toEqual([]);
  // A second reset starts from the marker this estate now holds.
  expect(await onB.reset()).toEqual({ preview: false, path: [root] });
});

/**
 * The same replacement on an estate whose `tables` list grew: the old history
 * created `fresh` through its widened list, and the new one creates it again.
 * Nothing this estate holds managed it, so reset cannot tell it from a table
 * the user made and has not adopted: it refuses, naming it, and drops nothing.
 */
const a = s.model({ id: s.string().id() }).map("a");
const fresh = s.model({ id: s.string().id(), v: s.int() }).map("fresh");
const freshOther = s.model({ id: s.string().id(), w: s.string() }).map("fresh");
const UNACCOUNTED = /reset cannot account for table "fresh"/;
const FOREIGN = /states this estate does not hold/;

const onEstate = (
  driver: ReturnType<typeof createInMemorySQLite3Driver>,
  storage: MemoryEstateStorage,
  schema: Record<string, unknown>,
  tables: readonly string[]
) =>
  createMigrationClient(
    createClient({ schema: schema as never, driver }) as never,
    { storage, tables }
  );

for (const [label, next] of [
  ["the same shape", fresh],
  ["another shape", freshOther],
] as const) {
  test(`reset refuses a widened-list table it cannot account for (${label})`, async () => {
    const driver = createInMemorySQLite3Driver();
    open.push(driver);
    const estateA = new MemoryEstateStorage();
    await onEstate(driver, estateA, { a }, ["a"]).generate({ name: "a" });
    const widened = onEstate(driver, estateA, { a, fresh }, ["a", "fresh"]);
    await widened.generate({ name: "fresh" });
    await widened.apply();
    await driver._executeRaw(
      `INSERT INTO "fresh" ("id", "v") VALUES ('row', 1)`
    );
    const markerBefore = (await widened.status()).marker;

    const estateB = new MemoryEstateStorage();
    await onEstate(driver, estateB, { a }, ["a"]).generate({ name: "a-again" });
    const onB = onEstate(driver, estateB, { a, fresh: next }, ["a", "fresh"]);
    await onB.generate({ name: "fresh-again" });
    expect((await onB.status()).markerState).toBe("unknown");

    for (const running of [onB.reset({ dryRun: true }), onB.reset()]) {
      await expect(running).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringMatching(UNACCOUNTED),
        meta: { table: "fresh" },
      });
    }
    await expect(onB.reset()).rejects.toThrow(FOREIGN);
    // Nothing ran: the table, its row and the old marker are where they were.
    expect((await driver._executeRaw(`SELECT * FROM "fresh"`)).rows).toEqual([
      { id: "row", v: 1 },
    ]);
    expect((await onB.status()).marker).toEqual(markerBefore);

    // Once the user says the rows can go, reset clears and replays.
    await driver._executeRaw(`DROP TABLE "fresh"`);
    expect((await onB.reset()).preview).toBe(false);
    expect(await onB.verify()).toEqual({ ok: true });
  });
}

test("reset refuses a raw listed table a later state of its own history creates", async () => {
  const driver = createInMemorySQLite3Driver();
  open.push(driver);
  const storage = new MemoryEstateStorage();
  await onEstate(driver, storage, { a }, ["a"]).generate({ name: "a" });
  await onEstate(driver, storage, { a }, ["a"]).apply();
  // Not applied yet: the live `fresh` is the user's own table.
  await onEstate(driver, storage, { a, fresh }, ["a", "fresh"]).generate({
    name: "fresh",
  });
  await driver._executeRaw(
    `CREATE TABLE "fresh" ("id" TEXT NOT NULL, "v" INTEGER NOT NULL, PRIMARY KEY ("id"))`
  );
  await driver._executeRaw(
    `INSERT INTO "fresh" ("id", "v") VALUES ('mine', 1)`
  );
  const onList = onEstate(driver, storage, { a, fresh }, ["a", "fresh"]);
  const refused = onList.reset();
  await expect(refused).rejects.toThrow(UNACCOUNTED);
  await expect(onList.reset()).rejects.not.toThrow(FOREIGN);
  expect((await driver._executeRaw(`SELECT * FROM "fresh"`)).rows).toEqual([
    { id: "mine", v: 1 },
  ]);
});
