import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { LiveMode } from "@query-engine/operations/nested-writes/live-mode";
import { PlannedMode } from "@query-engine/operations/nested-writes/planned-mode";
import { describe, expect, test, vi } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * M6 gate (§11 M6): the upsert family (top-level upsert + nested to-one/to-many
 * upsert) over FK-only trees runs THROUGH THE INTERPRETER in both modes. Gates:
 *
 *  1. Routing spy — `LiveMode.bindContext` / `PlannedMode.bindContext` fire
 *     exactly once per eligible top-level `upsert` (create branch and update
 *     branch alike); the old engines never touch these modes, so a call proves
 *     the tree was interpreted.
 *  2. Skip branches leave state untouched in both modes — a targetWhere/setWhere
 *     no-match is a silent no-op returning the existing row, persisting nothing.
 *  3. F1 regression guard (§0.3, §5.5 Pin Rule 2) — a top-level upsert of a
 *     MISSING key takes the create branch; the planned statement list must
 *     contain NO `NOT EXISTS` assertion before the create-branch INSERT. The
 *     shipped batch bug emitted `appendAssertUniqueMissing` before the INSERT,
 *     preempting the retryable `UniqueConstraintError`; Pin Rule 2 deletes it.
 *  4. A nested upsert routes through the interpreter (to-one and to-many).
 *  5. An m2m-touching upsert IS eligible at M9 (m2m migrated), so the
 *     interpreter mode is bound (assertion updated at M9).
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

// A batch-only driver that shares the same PGlite instance as its tx sibling and
// records the SQL of every batch it runs (for the F1 plan snapshot).
class RecordingBatchDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  readonly batches: string[][] = [];

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

async function setupDb(): Promise<PGlite> {
  const db = new PGlite();
  const setupClient = createClient({
    schema: nestedWriteBehaviorSchema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });
  return db;
}

function boot<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
}

describe("M6 upsert-family interpreter", () => {
  describe("upsert trees route through the interpreter", () => {
    test(
      "live mode binds LiveMode exactly once per upsert (create branch)",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.upsert({
          where: { id: "u1" },
          create: {
            id: "u1",
            name: "Created",
            posts: { create: { id: "po1", title: "Draft" } },
          },
          update: { name: "Unused" },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        expect(plannedSpy).not.toHaveBeenCalled();
        liveSpy.mockRestore();
        plannedSpy.mockRestore();
        await client.$disconnect();
      }
    );

    test(
      "batch mode binds PlannedMode exactly once per upsert (update branch)",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const setup = boot(new PGliteDriver({ client: db }));
        await setup.user.create({
          data: {
            id: "u1",
            name: "Owner",
            posts: { create: { id: "po1", title: "Draft" } },
          },
        });
        const client = boot(new RecordingBatchDriver({ client: db }));
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", name: "Unused" },
          update: {
            name: "Renamed",
            posts: {
              update: { where: { id: "po1" }, data: { title: "Published" } },
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

    // A nested to-one AND to-many upsert inside a top-level update stays eligible
    // and is interpreted end to end.
    test(
      "a nested upsert tree routes through the interpreter",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        await client.post.create({
          data: { id: "po1", title: "Orphan", userId: null },
        });
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");

        await client.post.update({
          where: { id: "po1" },
          data: {
            author: {
              upsert: {
                create: { id: "u1", name: "Created" },
                update: { name: "Unused" },
              },
            },
          },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        liveSpy.mockRestore();
        await client.$disconnect();
      }
    );

    // A top-level upsert whose UPDATE branch touches a true many-to-many relation
    // IS eligible at M9 (m2m migrated): whole-tree routing sends it to the
    // interpreter, so the mode is bound.
    test(
      "an m2m-touching upsert routes through the interpreter (M9)",
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

        await client.post.upsert({
          where: { id: "p1" },
          create: { id: "p1", title: "Post 1" },
          update: { tags: { connect: { id: "t1" } } },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        liveSpy.mockRestore();
        await client.$disconnect();
      }
    );
  });

  describe("skip branches leave state untouched in both modes", () => {
    async function runTargetWhereSkip(
      createDriver: (db: PGlite) => PGliteDriver
    ): Promise<{ userName: string; postTitle: string }> {
      const db = await setupDb();
      const seed = boot(new PGliteDriver({ client: db }));
      await seed.user.create({
        data: {
          id: "u1",
          name: "Alice",
          posts: { create: { id: "po1", title: "Draft" } },
        },
      });
      const client = boot(createDriver(db));
      // targetWhere no-match: the update branch (which would rename the user and
      // the post) must be skipped, persisting nothing.
      await client.user.upsert({
        where: { id: "u1" },
        targetWhere: { name: "Bob" },
        create: { id: "u-unused", name: "Unused" },
        update: {
          name: "Wrong target",
          posts: {
            update: { where: { id: "po1" }, data: { title: "Wrong target" } },
          },
        },
      });
      const [user, post] = await Promise.all([
        client.user.findUnique({ where: { id: "u1" } }),
        client.post.findUnique({ where: { id: "po1" } }),
      ]);
      await client.$disconnect();
      return {
        userName: user?.name as string,
        postTitle: post?.title as string,
      };
    }

    test(
      "targetWhere no-match persists nothing in both modes",
      { timeout: 30_000 },
      async () => {
        const tx = await runTargetWhereSkip(
          (db) => new PGliteDriver({ client: db })
        );
        const batch = await runTargetWhereSkip(
          (db) => new RecordingBatchDriver({ client: db })
        );
        expect(tx).toEqual({ userName: "Alice", postTitle: "Draft" });
        expect(batch).toEqual(tx);
      }
    );
  });

  describe("F1 regression guard: no notExists before an upsert create INSERT", () => {
    // A top-level upsert whose target is MISSING takes the create branch. Under
    // Pin Rule 2 the planned plan must NOT emit a `NOT EXISTS` assertion before
    // the create INSERT — the DB unique constraint is the enforcer and its
    // violation is the retryable signal.
    test(
      "missing-target upsert plan has no notExists before the create insert",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const driver = new RecordingBatchDriver({ client: db });
        const client = boot(driver);
        driver.batches.length = 0;

        await client.user.upsert({
          where: { id: "u-missing" },
          create: {
            id: "u-missing",
            name: "Created",
            posts: { create: { id: "po1", title: "Draft" } },
          },
          update: { name: "Unused" },
        });

        const plan = analyzeCreateBranchPlan(
          driver.batches.flat(),
          "nested_behavior_users"
        );
        expect(plan.insertIndex).toBeGreaterThanOrEqual(0);
        expect(plan.notExistsBefore).toEqual([]);
        await client.$disconnect();
      }
    );
  });
});

// Analyze the planned statement list for the F1 regression: the index of the
// first `INSERT INTO "table"` (the create-branch INSERT) and any `NOT EXISTS`
// assertion positioned before it. The F1 fix requires the missing-key premise to
// be enforced by the unique constraint at the INSERT, not by a preceding guard
// that would preempt the retryable signal — so `notExistsBefore` must be empty.
const NOT_EXISTS_PATTERN = /NOT\s+EXISTS/i;

function analyzeCreateBranchPlan(
  statements: string[],
  table: string
): { insertIndex: number; notExistsBefore: string[] } {
  const insertPattern = new RegExp(`INSERT INTO "${table}"`, "i");
  const insertIndex = statements.findIndex((sql) => insertPattern.test(sql));
  const before = insertIndex >= 0 ? statements.slice(0, insertIndex) : [];
  return {
    insertIndex,
    notExistsBefore: before.filter((sql) => NOT_EXISTS_PATTERN.test(sql)),
  };
}
