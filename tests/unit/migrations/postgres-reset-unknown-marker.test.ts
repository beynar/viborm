/**
 * `reset()` on PostgreSQL (PGlite) whose marker names a state the estate does
 * not hold: the case Pyxel met upgrading to 1.4.2. An estate replaced by a
 * fresh history (a new root, no shared states) meets a database that still
 * carries the old marker; `reanchor()` refuses (the schemas differ), and
 * `reset()` clears and replays. In 1.4.2 its dry run returned a plan and the
 * run refused with MIGRATION_CORRUPTION (V11022), asking the estate for the
 * marker's own snapshot. See `reset-unknown-marker.core.test.ts` (SQLite).
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { expect, test } from "vitest";

const legacy = s
  .model({ id: s.string().id(), email: s.string().unique() })
  .map("rum_legacy");
const current = s
  .model({ id: s.string().id(), title: s.string(), views: s.int().default(0) })
  .map("rum_current");

test("reset clears a foreign history and replays the new estate, as its dry run plans", async () => {
  const driver = new PGliteDriver();
  try {
    const onA = createMigrationClient(
      createClient({ schema: { legacy }, driver }),
      { storage: new MemoryEstateStorage() }
    );
    await onA.generate({ name: "a-root" });
    await onA.apply();
    await driver._executeRaw(
      `INSERT INTO "rum_legacy" ("id", "email") VALUES ('1', 'a@b')`
    );
    const onB = createMigrationClient(
      createClient({ schema: { current }, driver }),
      { storage: new MemoryEstateStorage() }
    );
    const root = (await onB.generate({ name: "b-root" })).stateId!;
    const tables = async () =>
      (
        await driver._executeRaw<{ name: string }>(
          `SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename LIKE 'rum_%' ORDER BY tablename`
        )
      ).rows.map((row) => row.name);

    expect((await onB.status()).markerState).toBe("unknown");
    await expect(onB.reanchor()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
    });
    const preview = await onB.reset({ dryRun: true });
    expect(preview).toMatchObject({ preview: true, path: [root] });
    expect(preview.tables).toEqual(["rum_legacy"]);

    expect(await onB.reset()).toEqual({ preview: false, path: [root] });
    expect(await tables()).toEqual(["rum_current"]);
    const status = await onB.status();
    expect(status.markerState).toBeUndefined();
    expect(status.marker?.stateId).toBe(root);
  } finally {
    await driver.disconnect();
  }
});
