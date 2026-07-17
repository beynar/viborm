import { createClient, type VibORMClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { manyToManySchema } from "../fixtures/many-to-many-schema";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * FK update/removal and many-to-many trees compile into OperationProgram.
 *
 *  1. Routing gate — every update family returns an operation-atomic program;
 *     many-to-many mutations appear as declarative relation statements.
 *  2. PK-change conformance — a literal PK rename and a computed `increment` PK
 *     update persist byte-identical end state in transaction and batch
 *     runtimes, exercising the computed-primary-key value path.
 *  3. No test binds or imports the deleted interpreter modes.
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

describe("update-family operation programs", () => {
  describe("update trees compile without legacy mode binding", () => {
    test(
      "transaction runtime executes the compiled relation program",
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
        const operation = client.user.update({
          where: { id: "u1" },
          data: {
            name: "Renamed",
            posts: {
              update: { where: { id: "po1" }, data: { title: "Published" } },
            },
          },
        });
        const program = operation.compile();

        expect(program.atomicity).toBe("operation");
        expect(program.steps.length).toBeGreaterThan(1);
        await operation;
        await client.$disconnect();
      }
    );

    test(
      "batch runtime executes the same compiled relation program",
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
        const operation = client.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              disconnect: { id: "po1" },
            },
          },
        });
        const program = operation.compile();

        expect(program.atomicity).toBe("operation");
        expect(program.steps.length).toBeGreaterThan(1);
        await operation;
        await client.$disconnect();
      }
    );

    test(
      "update-governed createMany composes the relation program",
      { timeout: 30_000 },
      async () => {
        const db = await setupBehaviorDb();
        const client = bootBehavior(new BatchDriver({ client: db }));
        await client.user.create({ data: { id: "u1", name: "Owner" } });
        const operation = client.user.update({
          where: { id: "u1" },
          data: {
            posts: {
              createMany: {
                data: [{ id: "po1", title: "Program child" }],
              },
            },
          },
        });
        const program = operation.compile();

        expect(program.atomicity).toBe("operation");
        await operation;
        await expect(
          client.post.findUnique({ where: { id: "po1" } })
        ).resolves.toMatchObject({ userId: "u1" });
        await client.$disconnect();
      }
    );

    test(
      "an m2m-touching update compiles a relation statement",
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
        const operation = client.post.update({
          where: { id: "p1" },
          data: { tags: { connect: { id: "t1" } } },
        });
        const program = operation.compile();

        expect(program.atomicity).toBe("operation");
        expect(JSON.stringify(program)).toContain('"kind":"relation"');
        await operation;
        await client.$disconnect();
      }
    );
  });

  describe("PK-change conformance: identical end state in both runtimes", () => {
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
      "literal PK rename persists identical state in both runtimes",
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
      "computed increment PK update persists identical state in both runtimes",
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
