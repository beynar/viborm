/**
 * Plan T3: `reanchor()` after a restore left the migration history older than
 * the database's marker. One real SQLite database with 10,000 rows, migrated
 * through one history and read back through a restored one that lacks the
 * marker's state.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { sql } from "@sql";
import { VibORMErrorCode } from "@src/errors";
import { createMigrationClient } from "@src/migrations/client";
import { appendLedger } from "@src/migrations/control";
import { getMigrationDriver } from "@src/migrations/drivers";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { eventIdFor } from "@src/migrations/v1-parse";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const ROWS = 10_000;
const member = s.model({ id: s.string().id(), email: s.string().unique() });
const named = s.model({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string().nullable(),
});

const open: { disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of open.splice(0)) await client.disconnect();
});

/** One database; `history(model, storage)` reads it through a history. */
function database() {
  const driver = createInMemorySQLite3Driver();
  open.push(driver);
  const history = (model: typeof member, storage: MemoryEstateStorage) =>
    createMigrationClient(createClient({ schema: { member: model }, driver }), {
      storage,
    });
  const rows = async () =>
    (
      await driver._executeRaw<{ n: number }>(
        `SELECT count(*) AS n FROM "member"`
      )
    ).rows[0]?.n;
  return { driver, history, rows };
}

const stateOf = async (published: Promise<{ stateId: string | null }>) => {
  const { stateId } = await published;
  if (!stateId) throw new Error("expected a published state");
  return stateId;
};

/** A manual transition from `from` that changes data and no schema. */
const dataOnly = (name: string, from: string) => ({
  name,
  from,
  manualMigration: {
    transitions: [
      {
        from,
        execution: "transactional" as const,
        up: [sql`UPDATE "member" SET email = lower(email)`],
        originChecks: [
          { kind: "trusted-read" as const, query: sql`SELECT 1`, equals: true },
        ],
        rollback: { kind: "irreversible" as const, reason: "data" },
      },
    ],
    destinationChecks: [
      { kind: "trusted-read" as const, query: sql`SELECT 1`, equals: true },
    ],
  },
});

/** Applied `a` then `b` with rows; the restored history holds `a` only. */
async function restoredBehind() {
  const db = database();
  const original = new MemoryEstateStorage();
  const a = await stateOf(db.history(member, original).generate({ name: "a" }));
  await db.history(member, original).apply();
  const migrated = db.history(named, original);
  const b = await stateOf(migrated.generate({ name: "b" }));
  await migrated.apply();
  await db.driver._executeRaw(
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "member" (id, email, name) SELECT 'm' || i, 'm' || i || '@example.com', 'name ' || i FROM n`
  );
  const restored = new MemoryEstateStorage();
  // Same document, same name, same parent: the regenerated id is identical.
  const regenerated = await stateOf(
    db.history(member, restored).generate({ name: "a" })
  );
  return { ...db, original, restored, a, b, regenerated };
}

describe("reanchor after a restore", () => {
  test("moves the marker onto the matching known state, re-rooted at a baseline boundary", async () => {
    const {
      history,
      restored,
      rows,
      a,
      b,
      regenerated: regeneratedA,
    } = await restoredBehind();
    expect(regeneratedA).toBe(a);
    const migrations = history(named, restored);
    expect((await migrations.status()).markerState).toBe("ahead");
    await expect(migrations.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
    });
    const before = (await migrations.status()).marker;

    // Nothing in the restored history matches: refused with the difference.
    await expect(migrations.reanchor()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: expect.stringContaining('"name"'),
    });

    // Regenerated under another name: another id with the live schema.
    const regenerated = await stateOf(
      migrations.generate({ name: "b-regenerated" })
    );
    expect(regenerated).not.toBe(b);
    await expect(migrations.reanchor()).resolves.toEqual({
      stateId: regenerated,
    });
    const status = await migrations.status();
    expect(status).toMatchObject({ pending: [], unfinished: false });
    expect(status.markerState).toBeUndefined();
    expect(status.marker).toMatchObject({
      stateId: regenerated,
      revision: (before?.revision ?? 0) + 1,
      path: [
        { stateId: a, baselineBoundary: true },
        { stateId: regenerated, baselineBoundary: false },
      ],
    });
    expect((await migrations.log()).at(-1)).toMatchObject({
      kind: "reanchored",
      direction: "baseline",
      fromState: b,
      toState: regenerated,
    });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "noop",
    });
    // Down stops at the new baseline boundary; the rows never moved.
    await expect(migrations.down({ steps: 2 })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    expect(await rows()).toBe(ROWS);
  });

  test("refuses a marker this history holds, and a database without one", async () => {
    const { history, original, restored } = await restoredBehind();
    await expect(history(named, original).reanchor()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    const fresh = database();
    const unmarked = new MemoryEstateStorage();
    await fresh.history(member, unmarked).generate({ name: "a" });
    await expect(
      fresh.history(member, unmarked).reanchor()
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    expect((await history(named, restored).status()).markerState).toBe("ahead");
  });

  test("refuses when several known states match; reanchor({ to }) adopts the one named", async () => {
    const { history, restored, rows, a } = await restoredBehind();
    // Two branches from `a` with the live schema, under two names.
    const migrations = history(named, restored);
    const first = await stateOf(
      migrations.generate({ name: "b-one", from: a })
    );
    const second = await stateOf(
      migrations.generate({ name: "b-two", from: a })
    );
    const several = migrations.reanchor();
    await expect(several).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    await expect(several).rejects.toThrow(first);
    await expect(several).rejects.toThrow(second);
    // An explicit `to` still needs the live schema to match it.
    await expect(
      migrations.reanchor({ to: { name: "a" } })
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_DRIFT });
    expect((await migrations.status()).markerState).toBe("ahead");
    await expect(
      migrations.reanchor({ to: { name: "b-two" } })
    ).resolves.toEqual({ stateId: second });
    await expect(migrations.verify()).resolves.toEqual({ ok: true });
    expect(await rows()).toBe(ROWS);
  });

  test("refuses a route with a data-only transition: equal schemas never prove equal data", async () => {
    const { history, restored, a } = await restoredBehind();
    const data = await stateOf(
      history(member, restored).generate(dataOnly("backfill", a))
    );
    const migrations = history(named, restored);
    await migrations.generate({ name: "b-after-backfill", from: data });
    await expect(migrations.reanchor()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("data-only"),
    });
    expect((await migrations.status()).markerState).toBe("ahead");
  });

  test("refuses a state the marker passed through: the lost transitions moved data only", async () => {
    const { driver, history, rows } = database();
    const original = new MemoryEstateStorage();
    const a = await stateOf(history(member, original).generate({ name: "a" }));
    await history(member, original).apply();
    await driver._executeRaw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "member" (id, email) SELECT 'm' || i, 'M' || i || '@example.com' FROM n`
    );
    await history(member, original).generate(dataOnly("backfill", a));
    await history(member, original).apply();
    const restored = new MemoryEstateStorage();
    await history(member, restored).generate({ name: "a" });
    const migrations = history(member, restored);
    expect((await migrations.status()).markerState).toBe("ahead");
    // The live schema matches `a`, but moving back onto it would replay backfill.
    for (const options of [{}, { to: { name: "a" } }]) {
      await expect(migrations.reanchor(options)).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining(a),
      });
    }
    // Regenerating the lost state from the same inputs restores its id.
    await migrations.generate(dataOnly("backfill", a));
    expect((await migrations.status()).markerState).toBeUndefined();
    await expect(migrations.apply()).resolves.toMatchObject({
      outcome: "noop",
    });
    expect(await rows()).toBe(ROWS);
  });

  test("refuses while an attempt is unfinished", async () => {
    const { driver, history, restored, a } = await restoredBehind();
    const migrations = history(named, restored);
    await migrations.generate({ name: "b-regenerated" });
    const applied = (await migrations.log()).at(-1);
    if (!applied) throw new Error("expected a ledger event");
    // An attempt that opened and never closed.
    const { eventId: _, ...body } = {
      ...applied,
      kind: "started" as const,
      attemptId: a,
      finishedAt: null,
    };
    await appendLedger(driver, getMigrationDriver(driver), {
      ...body,
      eventId: eventIdFor(body),
    });
    await expect(migrations.reanchor()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("unfinished"),
    });
  });
});
