import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { RelationMutations } from "@query-engine/RelationMutations";
import { s } from "@schema";
import { describe, expect, test, vi } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

// A self-referential parent-holds-FK model: `parent` is a manyToOne to the same
// model, its FK (`parentId`) sitting on the parent row. Creating a category
// with a nested `parent: { create }` inserts a SAME-MODEL child (the parent's
// parent) BEFORE the top-level row (FK split, before-parent). A scalar-only
// create must still return the TOP-LEVEL row, not the nested child — the review
// found transaction strategy's old first-insert-into-root-model anchor heuristic returned
// the child here (a two-mode divergence and a regression vs the frozen engines).
const selfRefFkSchema = (() => {
  const category = s
    .model({
      id: s.string().id(),
      name: s.string(),
      parentId: s.string().nullable(),
      parent: s
        .manyToOne(() => category)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => category),
    })
    .map("m3_selfref_categories");
  return { category };
})();

/**
 * Create/createMany/connect/connectOrCreate and many-to-many trees compile to
 * one OperationProgram for transaction and atomic-batch execution.
 *
 *  1. Routing spy — `RelationMutations.compileCreate` is called exactly once
 *     and yields an operation-atomic program for an eligible create.
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

describe("relation create-family execution", () => {
  describe("pure FK create trees route through OperationProgram", () => {
    test(
      "transaction execution compiles one create program",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        const compileSpy = vi.spyOn(
          RelationMutations.prototype,
          "compileCreate"
        );

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

        expect(compileSpy).toHaveBeenCalledTimes(1);
        expect(compileSpy.mock.results[0]?.value).toMatchObject({
          atomicity: "operation",
        });
        compileSpy.mockRestore();
        await client.$disconnect();
      }
    );

    test(
      "batch execution compiles one create program",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new RecordingBatchDriver({ client: db }));
        const compileSpy = vi.spyOn(
          RelationMutations.prototype,
          "compileCreate"
        );

        await client.user.create({
          data: {
            id: "u1",
            name: "Alice",
            posts: { create: { id: "po1", title: "First" } },
          },
        });

        expect(compileSpy).toHaveBeenCalledTimes(1);
        expect(compileSpy.mock.results[0]?.value).toMatchObject({
          atomicity: "operation",
        });
        compileSpy.mockRestore();
        await client.$disconnect();
      }
    );

    test(
      "native transaction arrays use only compiled nested create programs",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const driver = new RecordingBatchDriver({ client: db });
        const client = boot(driver);
        const compileSpy = vi.spyOn(
          RelationMutations.prototype,
          "compileCreate"
        );

        const [created] = await client.$transaction([
          client.user.create({
            data: {
              id: "u1",
              name: "Alice",
              posts: { create: { id: "po1", title: "First" } },
            },
          }),
        ]);

        expect(created.id).toBe("u1");
        expect(compileSpy).toHaveBeenCalled();
        expect(
          compileSpy.mock.results.every(
            (result) => result.value?.atomicity === "operation"
          )
        ).toBe(true);
        expect(driver.batches).toHaveLength(1);
        compileSpy.mockRestore();
        await client.$disconnect();
      }
    );

    // A deep FK-only create tree (junction rows here are a plain FK oneToMany,
    // and their `tag: { connect }` is manyToOne — both FK) stays eligible and
    // is compiled end to end.
    test(
      "a deep FK-only create tree compiles recursively",
      { timeout: 30_000 },
      async () => {
        const db = await setupDb();
        const client = boot(new PGliteDriver({ client: db }));
        await client.tag.create({ data: { id: "t1", name: "tag" } });
        const compileSpy = vi.spyOn(
          RelationMutations.prototype,
          "compileCreate"
        );

        await client.post.create({
          data: {
            id: "po1",
            title: "With junction",
            userId: null,
            postTags: { create: { id: "j1", tag: { connect: { id: "t1" } } } },
          },
        });

        const program = compileSpy.mock.results[0]?.value;
        expect(compileSpy).toHaveBeenCalledTimes(1);
        expect(
          program?.steps.filter((step) => step.kind === "write")
        ).toHaveLength(2);
        expect(program?.steps.some((step) => step.kind === "guard")).toBe(true);
        compileSpy.mockRestore();
        await client.$disconnect();
      }
    );

    // A true many-to-many create is part of the same operation program. The
    // relation statement remains compiler-owned and the runtime sees only the
    // closed program vocabulary.
    test(
      "an m2m create-through-junction compiles into OperationProgram",
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
        const operation = client.post.create({
          data: {
            id: "p1",
            title: "Post 1",
            tags: { connect: { id: "t1" } },
          },
        });
        const program = operation.compile();

        expect(program.atomicity).toBe("operation");
        expect(JSON.stringify(program)).toContain('"kind":"relation"');
        await operation;
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

  // Regression (§6.1/§9, §8.2): a self-referential parent-holds-FK create with a
  // scalar-only result must return the TOP-LEVEL row in BOTH modes. transaction strategy
  // used to return the nested same-model child (the "grandparent") because its
  // anchor was the first insert into the root model, and the before-parent child
  // insert fires first for a self-referential FK. The interpreter now threads the
  // outermost create's own row structurally, so both modes agree on `root`.
  test(
    "self-referential parent-holds-FK create returns the top-level row in both modes",
    { timeout: 30_000 },
    async () => {
      const txResult = await runSelfRefCreate(
        (db) => new PGliteDriver({ client: db })
      );
      const batchResult = await runSelfRefCreate(
        (db) => new RecordingBatchDriver({ client: db })
      );
      // The scalar-only result is the top-level parent, not the nested child.
      expect(txResult).toEqual({
        id: "root",
        name: "Root",
        parentId: "gp",
      });
      // Byte-identical across the two substrates.
      expect(batchResult).toEqual(txResult);
    }
  );
});

async function runSelfRefCreate(
  createDriver: (db: PGlite) => PGliteDriver
): Promise<unknown> {
  const db = new PGlite();
  const setupClient = createClient({
    schema: selfRefFkSchema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });
  const client = createClient({
    schema: selfRefFkSchema,
    driver: createDriver(db),
  });
  const created = await client.category.create({
    data: {
      id: "root",
      name: "Root",
      parent: { create: { id: "gp", name: "Grandparent" } },
    },
  });
  await client.$disconnect();
  return created;
}

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
