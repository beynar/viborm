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
