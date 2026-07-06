import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { LiveMode } from "@query-engine/operations/nested-writes/live-mode";
import { PlannedMode } from "@query-engine/operations/nested-writes/planned-mode";
import { s } from "@schema";
import { describe, expect, test, vi } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * M5 gate (§11 M5): the update family (update / updateMany / disconnect /
 * delete / deleteMany / set) over FK-only trees runs THROUGH THE INTERPRETER in
 * both modes. Load-bearing assertions beyond the conformance oracle:
 *
 *  1. Routing spy — `LiveMode.bindContext` / `PlannedMode.bindContext` fire
 *     exactly once per eligible top-level `update` (the old engines never touch
 *     these modes, so a call proves the tree was interpreted).
 *  2. PK-change conformance — a literal PK rename and a computed `increment` PK
 *     update persist byte-identical end state in both modes, exercising the
 *     `computedPk` symbol path (live: scalar SELECT read-back; planned:
 *     store(valueSql)).
 *  3. An m2m-touching update tree IS eligible at M9 (m2m migrated), so the
 *     interpreter mode is bound (assertion updated at M9).
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

// A batch-only driver that shares the same PGlite instance as its tx sibling so
// the two modes run head-to-head over identical seeded state.
class BatchDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

async function setupBehaviorDb(): Promise<PGlite> {
  const db = new PGlite();
  const setupClient = createClient({
    schema: nestedWriteBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });
  return db;
}

function bootBehavior<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
}

// A numeric-PK schema for the computed-PK (increment) update path.
const counterSchema = (() => {
  const counter = s
    .model({
      id: s.int().id(),
      label: s.string(),
    })
    .map("m5_counters");
  return { counter };
})();

describe("M5 update-family interpreter", () => {
  describe("update trees route through the interpreter", () => {
    test(
      "live mode binds LiveMode exactly once per update",
      { timeout: 30_000 },
      async () => {
        const db = await setupBehaviorDb();
        const client = bootBehavior(new PGliteDriver({ client: db }));
        await client.user.create({
          data: {
            id: "u1",
            name: "Owner",
            posts: { create: { id: "po1", title: "Draft" } },
          },
        });
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.update({
          where: { id: "u1" },
          data: {
            name: "Renamed",
            posts: {
              update: { where: { id: "po1" }, data: { title: "Published" } },
              create: { id: "po2", title: "New" },
            },
          },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        expect(plannedSpy).not.toHaveBeenCalled();
        liveSpy.mockRestore();
        plannedSpy.mockRestore();
        await client.$disconnect();
      }
    );

    test(
      "batch mode binds PlannedMode exactly once per update",
      { timeout: 30_000 },
      async () => {
        const db = await setupBehaviorDb();
        const client = bootBehavior(new BatchDriver({ client: db }));
        await client.user.create({
          data: {
            id: "u1",
            name: "Owner",
            posts: { create: { id: "po1", title: "Draft" } },
          },
        });
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              disconnect: { id: "po1" },
            },
          },
        });

        expect(plannedSpy).toHaveBeenCalledTimes(1);
        expect(liveSpy).not.toHaveBeenCalled();
        liveSpy.mockRestore();
        plannedSpy.mockRestore();
        await client.$disconnect();
      }
    );

    test(
      "an m2m-touching update routes through the interpreter (M9)",
      { timeout: 30_000 },
      async () => {
        const db = new PGlite();
        const setupClient = createClient({
          schema: manyToManySchema,
          driver: new PGliteDriver({ client: db }),
        });
        await push(setupClient, { force: true });
        const client = createClient({
          schema: manyToManySchema,
          driver: new PGliteDriver({ client: db }),
        });
        await client.tag.create({
          data: { id: "t1", name: "tag-1", featuredPostId: null },
        });
        await client.post.create({ data: { id: "p1", title: "Post 1" } });
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");

        await client.post.update({
          where: { id: "p1" },
          data: { tags: { connect: { id: "t1" } } },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        liveSpy.mockRestore();
        await client.$disconnect();
      }
    );
  });

  describe("PK-change conformance: identical end state in both modes", () => {
    async function runPkChange(
      createDriver: (db: PGlite) => PGliteDriver,
      act: (client: ReturnType<typeof bootCounter>) => PromiseLike<unknown>
    ): Promise<Array<{ id: number; label: string }>> {
      const db = new PGlite();
      const setup = createClient({
        schema: counterSchema,
        driver: new PGliteDriver({ client: db }),
      });
      await push(setup, { force: true });
      const client = bootCounter(createDriver(db));
      await client.counter.create({ data: { id: 5, label: "start" } });
      await act(client);
      const rows = await client.counter.findMany({ orderBy: { id: "asc" } });
      await client.$disconnect();
      return rows as Array<{ id: number; label: string }>;
    }

    function bootCounter(driver: PGliteDriver) {
      return createClient({ schema: counterSchema, driver });
    }

    test(
      "literal PK rename persists identical state in both modes",
      { timeout: 30_000 },
      async () => {
        const act = (client: ReturnType<typeof bootCounter>) =>
          client.counter.update({
            where: { id: 5 },
            data: { id: 9, label: "renamed" },
          });
        const tx = await runPkChange(
          (db) => new PGliteDriver({ client: db }),
          act
        );
        const batch = await runPkChange(
          (db) => new BatchDriver({ client: db }),
          act
        );
        expect(tx).toEqual([{ id: 9, label: "renamed" }]);
        expect(batch).toEqual(tx);
      }
    );

    test(
      "computed increment PK update persists identical state in both modes",
      { timeout: 30_000 },
      async () => {
        const act = (client: ReturnType<typeof bootCounter>) =>
          client.counter.update({
            where: { id: 5 },
            data: { id: { increment: 100 }, label: "bumped" },
          });
        const tx = await runPkChange(
          (db) => new PGliteDriver({ client: db }),
          act
        );
        const batch = await runPkChange(
          (db) => new BatchDriver({ client: db }),
          act
        );
        expect(tx).toEqual([{ id: 105, label: "bumped" }]);
        expect(batch).toEqual(tx);
      }
    );
  });
});
