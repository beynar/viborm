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
 * M3 gate (§11 M3): the create family (create / createMany / connect /
 * connectOrCreate) over FK-only trees runs THROUGH THE INTERPRETER in both
 * modes. Two load-bearing assertions:
 *
 *  1. Routing spy — `LiveMode.bindContext` / `PlannedMode.bindContext` are
 *     called exactly once per eligible create operation. The interpreter binds
 *     the root context before `scope.run`; the old engines never touch these
 *     modes, so a call proves the tree was interpreted, not delegated.
 *
 *  2. F1 regression guard (§0.3, §5.5 Pin Rule 2) — the planned statement list
 *     for a connectOrCreate/upsert-shaped create-branch contains NO `NOT
 *     EXISTS` assertion before the create-branch INSERT. The shipped batch bug
 *     emitted a `uniqueMissing` guard before the INSERT, preempting the
 *     retryable `UniqueConstraintError`; Pin Rule 2 deletes that pin.
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;
type BehaviorClient = VibORMClient<{
  schema: BehaviorSchema;
  driver: PGliteDriver;
}>;

// A batch-only driver that records the SQL statements of every batch it runs.
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

describe("M3 create-family interpreter", () => {
  describe("create trees route through the interpreter", () => {
    test(
      "live mode binds LiveMode exactly once per create",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.create({
          data: {
            id: "u1",
            name: "Alice",
            profile: { create: { id: "pr1", bio: "bio" } },
            posts: {
              createMany: {
                data: [
                  { id: "po1", title: "First" },
                  { id: "po2", title: "Second" },
                ],
              },
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
      "batch mode binds PlannedMode exactly once per create",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new RecordingBatchDriver({ client: db }));
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");
        const plannedSpy = vi.spyOn(PlannedMode.prototype, "bindContext");

        await client.user.create({
          data: {
            id: "u1",
            name: "Alice",
            posts: { create: { id: "po1", title: "First" } },
          },
        });

        expect(plannedSpy).toHaveBeenCalledTimes(1);
        expect(liveSpy).not.toHaveBeenCalled();
        liveSpy.mockRestore();
        plannedSpy.mockRestore();
        await client.$disconnect();
      }
    );

    // A deep FK-only create tree (junction rows here are a plain FK oneToMany,
    // and their `tag: { connect }` is manyToOne — both FK) stays eligible and
    // is interpreted end to end.
    test(
      "a deep FK-only create tree routes through the interpreter",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        await client.tag.create({ data: { id: "t1", name: "tag" } });
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");

        await client.post.create({
          data: {
            id: "po1",
            title: "With junction",
            userId: null,
            postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
          },
        });

        expect(liveSpy).toHaveBeenCalledTimes(1);
        liveSpy.mockRestore();
        await client.$disconnect();
      }
    );

    // A create tree touching a TRUE many-to-many relation is NOT eligible at M3
    // (m2m lands at M9): whole-tree routing sends it to the frozen engines, so
    // neither mode is bound.
    test(
      "an m2m create-through-junction does NOT route through the interpreter",
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
        const liveSpy = vi.spyOn(LiveMode.prototype, "bindContext");

        await client.post.create({
          data: {
            id: "p1",
            title: "Post 1",
            tags: { connect: { id: "t1" } },
          },
        });

        expect(liveSpy).not.toHaveBeenCalled();
        liveSpy.mockRestore();
        await client.$disconnect();
      }
    );
  });

  describe("F1 regression guard: no notExists before a create-branch INSERT", () => {
    // A connectOrCreate whose target is MISSING takes the create branch. Under
    // Pin Rule 2 the planned plan must NOT emit a `NOT EXISTS` assertion before
    // the child INSERT — the DB unique constraint is the enforcer and its
    // violation is the retryable signal.
    test(
      "connectOrCreate missing-branch plan has no notExists before the child insert",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const driver = new RecordingBatchDriver({ client: db });
        const client = boot(driver);
        // Seed a post so the parent update has a row; the target user is missing.
        await client.post.create({
          data: { id: "po1", title: "Orphan", userId: null },
        });
        driver.batches.length = 0;

        await client.post.create({
          data: {
            id: "po2",
            title: "COC",
            author: {
              connectOrCreate: {
                where: { id: "u-missing" },
                create: { id: "u-missing", name: "Created" },
              },
            },
          },
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

    test(
      "createMany duplicate-PK plan has no pre-insert notExists guard",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const driver = new RecordingBatchDriver({ client: db });
        const client = boot(driver);
        driver.batches.length = 0;

        await expect(
          client.user.create({
            data: {
              id: "u1",
              name: "Kate",
              posts: {
                createMany: {
                  data: [
                    { id: "dup", title: "First" },
                    { id: "dup", title: "Duplicate" },
                  ],
                },
              },
            },
          })
        ).rejects.toThrow();

        // The duplicate-PK failure must surface from the INSERT itself, never a
        // pre-insert assertion. No NOT EXISTS may precede the posts INSERT.
        const plan = analyzeCreateBranchPlan(
          driver.batches.flat(),
          "nested_behavior_posts"
        );
        expect(plan.insertIndex).toBeGreaterThanOrEqual(0);
        expect(plan.notExistsBefore).toEqual([]);
        await client.$disconnect();
      }
    );
  });

  // Byte-identical scalar-only result parity between the two modes for a mixed
  // create tree (mapped FK propagation covered by the conformance oracle).
  test(
    "mapped-column FK propagation returns identical scalars in both modes",
    { timeout: 30_000 },
    async () => {
      const txResult = await runMappedCreate(
        (db) => new PGliteDriver({ client: db })
      );
      const batchResult = await runMappedCreate(
        (db) => new RecordingBatchDriver({ client: db })
      );
      expect(batchResult).toEqual(txResult);
    }
  );
});

async function runMappedCreate(
  createDriver: (db: PGlite) => PGliteDriver
): Promise<unknown> {
  const db = await setupDb();
  const client = boot(createDriver(db)) as BehaviorClient;
  const created = await client.mappedUser.create({
    data: {
      id: "mu1",
      name: "Mapped",
      posts: {
        createMany: {
          data: [{ id: "mp1", title: "First" }],
        },
      },
    },
  });
  await client.$disconnect();
  return created;
}

// Analyze the planned statement list for the F1 regression: the index of the
// first `INSERT INTO "table"` (the create-branch INSERT) and any `NOT EXISTS`
// assertion positioned before it. The F1 fix requires the missing-key premise
// to be enforced by the unique constraint at the INSERT, not by a preceding
// guard that would preempt the retryable signal — so `notExistsBefore` must be
// empty. Returns data; the tests own the assertions.
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
