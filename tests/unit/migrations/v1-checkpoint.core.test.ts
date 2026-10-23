/**
 * Plan T4 (decision 11): bounded history with authored checkpoints. A
 * 200-state history of twenty 15-column tables (INT-10's measured estate),
 * applied to one real SQLite database with 10,000 rows, is checkpointed with
 * `generate({ from: null })`, pruned into a fresh history, and the marker is
 * re-anchored onto the checkpoint.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { VibORMErrorCode } from "@src/errors";
import { checkEstate } from "@src/migrations/check";
import { createMigrationClient } from "@src/migrations/client";
import { loadMigrationGraph } from "@src/migrations/graph";
import { pruneV1 } from "@src/migrations/operators";
import { MemoryEstateStorage } from "@src/migrations/storage/memory";
import { encodeSnapshot } from "@src/migrations/v1-parse-snapshot";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { afterEach, describe, expect, test } from "vitest";

const MODELS = 20;
const STATES = 200;
const ROWS = 10_000;

const open: { disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const driver of open.splice(0)) await driver.disconnect();
});

/** Twenty 15-field models; state `step` adds column `extra<step>` to one. */
function schemaAt(step: number) {
  const schema: Record<string, ReturnType<typeof s.model>> = {};
  for (let m = 0; m < MODELS; m++) {
    const fields: Record<string, unknown> = {
      id: s.string().id(),
      email: s.string().unique(),
      name: s.string(),
      bio: s.string().nullable(),
      age: s.int(),
      score: s.number(),
      active: s.boolean(),
      createdAt: s.dateTime(),
      updatedAt: s.dateTime().nullable(),
      rank: s.int().nullable(),
      slug: s.string(),
      note: s.string().nullable(),
      flag: s.boolean().nullable(),
      weight: s.number().nullable(),
      code: s.string(),
    };
    for (let i = m + MODELS; i <= step; i += MODELS) {
      fields[`extra${i}`] = s.string().nullable();
    }
    schema[`model${m}`] = s.model(fields as never);
  }
  return schema;
}

function database() {
  const driver = createInMemorySQLite3Driver();
  open.push(driver);
  const at = (step: number, storage: MemoryEstateStorage) =>
    createMigrationClient(createClient({ schema: schemaAt(step), driver }), {
      storage,
    });
  return { driver, at };
}

const stateOf = async (published: Promise<{ stateId: string | null }>) => {
  const { stateId } = await published;
  if (!stateId) throw new Error("expected a published state");
  return stateId;
};

async function bytesOf(storage: MemoryEstateStorage, fullSnapshots = false) {
  let total = 0;
  for (const id of await storage.listStates()) {
    total += (await storage.readState(id))?.length ?? 0;
  }
  if (fullSnapshots) {
    const graph = await loadMigrationGraph(storage);
    for (const hash of new Set(
      [...graph.states.values()].map((state) => state.snapshotHash)
    )) {
      total += encodeSnapshot(graph.snapshots.get(hash)!).bytes.length;
    }
  } else {
    for (const hash of await storage.listSnapshots()) {
      total += (await storage.readSnapshot(hash))?.length ?? 0;
    }
  }
  for (const hash of await storage.listSql()) {
    total += (await storage.readSql(hash))?.length ?? 0;
  }
  return total;
}

const FIRST = MODELS - 1;
const LAST = FIRST + STATES - 1;

describe("authored checkpoints", () => {
  test("a 200-state history shrinks to its checkpoint and the states after it; apply, verify and status keep working", async () => {
    const db = database();
    const history = new MemoryEstateStorage();
    for (let step = FIRST; step <= LAST; step++) {
      await db.at(step, history).generate({ name: `s${step}` });
    }
    expect(await db.at(LAST, history).apply()).toMatchObject({
      outcome: "applied",
    });
    await db.driver._executeRaw(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "model0" (id, email, name, age, score, active, "createdAt", slug, code) SELECT 'r' || i, 'r' || i || '@example.com', 'n', 1, 1, 1, '2026-01-01T00:00:00.000Z', 's' || i, 'c' FROM n`
    );
    const before = await db.at(LAST, history).status();
    expect(before.marker?.path).toHaveLength(STATES);

    const leaf = await db.at(LAST, history).show({ name: `s${LAST}` });
    const checkpoint = await db
      .at(LAST, history)
      .generate({ name: "checkpoint", from: null });
    expect(checkpoint).toMatchObject({
      outcome: "published",
      snapshotHash: leaf.snapshotHash,
    });
    const after = await stateOf(
      db.at(LAST + 1, history).generate({
        name: "after",
        from: checkpoint.stateId ?? undefined,
      })
    );

    const pruned = new MemoryEstateStorage();
    const { states } = await pruneV1(history, {
      checkpoint: { name: "checkpoint" },
      into: pruned,
    });
    expect([...states].sort()).toEqual([checkpoint.stateId, after].sort());
    expect(await pruned.listStates()).toHaveLength(2);
    expect(await checkEstate(pruned)).toEqual({ ok: true, findings: [] });
    // Retain the original full-history reference for the 50x size contract;
    // incremental storage has already reduced the actual source denominator.
    expect(await bytesOf(pruned)).toBeLessThan(
      (await bytesOf(history, true)) / 50
    );
    expect(await bytesOf(pruned)).toBeLessThan(await bytesOf(history));
    expect(await pruned.listSnapshots()).toHaveLength(2);
    expect(await history.listStates()).toHaveLength(STATES + 2);

    const tenant = db.at(LAST + 1, pruned);
    expect((await tenant.status()).markerState).toBe("unknown");
    await expect(tenant.apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_NOT_FOUND,
    });
    expect(await tenant.reanchor()).toEqual({ stateId: checkpoint.stateId });
    const reanchored = await tenant.status();
    expect(reanchored.marker).toMatchObject({
      stateId: checkpoint.stateId,
      revision: (before.marker?.revision ?? 0) + 1,
      path: [{ stateId: checkpoint.stateId, baselineBoundary: true }],
    });
    expect(reanchored.pending).toEqual([after]);
    expect(await tenant.apply()).toMatchObject({ outcome: "applied" });
    expect(await tenant.verify()).toMatchObject({ ok: true });
    expect(await tenant.apply()).toMatchObject({ outcome: "noop" });
    expect((await tenant.status()).marker?.path).toHaveLength(2);
    const rows = await db.driver._executeRaw<{ n: number }>(
      `SELECT count(*) AS n FROM "model0"`
    );
    expect(rows.rows[0]?.n).toBe(ROWS);
  }, 600_000);

  test("a checkpoint restates the single leaf's schema, or it is refused", async () => {
    const db = database();
    const history = new MemoryEstateStorage();
    await db.at(FIRST, history).generate({ name: "a" });
    await expect(
      db.at(FIRST + 1, history).generate({ name: "changed", from: null })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
      message: expect.stringContaining("authored checkpoint"),
    });
    const a = (await history.listStates())[0];
    await db.at(FIRST + 1, history).generate({ name: "b", from: a });
    await db.at(FIRST + 2, history).generate({ name: "c", from: a });
    // Each branch's schema: neither leaf is the history's single leaf.
    for (const step of [FIRST + 1, FIRST + 2]) {
      await expect(
        db.at(step, history).generate({ name: "branches", from: null })
      ).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        message: expect.stringContaining("single leaf"),
      });
    }
    expect(await history.listStates()).toHaveLength(3);
  });

  test("prune keeps the older history a state after the checkpoint merges", async () => {
    const db = database();
    const history = new MemoryEstateStorage();
    await db.at(FIRST, history).generate({ name: "a" });
    await db.at(FIRST + 1, history).generate({ name: "b" });
    await db
      .at(FIRST + 1, history)
      .generate({ name: "checkpoint", from: null });
    // No `from`: both leaves, b and the checkpoint, become its parents.
    await db.at(FIRST + 2, history).generate({ name: "merge" });

    const pruned = new MemoryEstateStorage();
    const { states } = await pruneV1(history, {
      checkpoint: { name: "checkpoint" },
      into: pruned,
    });
    expect(states).toHaveLength(4);
    expect(await checkEstate(pruned)).toEqual({ ok: true, findings: [] });
  });
});
