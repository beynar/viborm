import { createClient, type VibORMClient } from "@client/client";
import type { Driver } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type {
  BatchQuery,
  QueryResult,
  TransactionOptions,
} from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { nestedWriteBehaviorSchema } from "../fixtures/nested-write-behavior-schema";

/**
 * M2 uniform legality gate (§11 M2 / §6.3).
 *
 * `assertPlanExecutable` routes all static validation through one throw site,
 * before either old engine runs, in BOTH modes. The gate proves:
 *  - the "unsupported nested create keys reject before parent mutation"
 *    contract holds in both modes (0 rows persisted);
 *  - D5 is closed — an input the tx engine used to BEGIN (open a transaction /
 *    issue a locking read) and then fail on mid-execution is now rejected up
 *    front, before any transaction is opened or any batch is issued, with the
 *    same typed message in both modes.
 *
 * The D5 probe is a top-level upsert whose update branch nests a `updateMany`
 * carrying a relation write. The tx `executeExistingUpsert` used to open a
 * transaction and `SELECT ... FOR UPDATE` before `assertNestedUpdatePlanIsExecutable`
 * rejected it; the gate now rejects it before the transaction is opened.
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

type BehaviorClient = VibORMClient<{
  schema: BehaviorSchema;
  driver: PGliteDriver;
}>;

const UPDATE_MANY_RELATION_MESSAGE =
  "Nested relation writes inside updateMany data for relation 'posts' are not supported.";

// A tx driver that counts how many transactions it opens. If the gate rejects
// up front, no transaction is ever opened for the rejected operation.
class TxSpyDriver extends PGliteDriver {
  override readonly supportsTransactions = true;
  override readonly supportsBatch = false;
  txOpened = 0;

  override withTransaction<T>(
    fn: (txDriver: Driver<PGlite, Transaction>) => Promise<T>,
    options?: TransactionOptions
  ): Promise<T> {
    this.txOpened++;
    return super.withTransaction(fn, options);
  }
}

// A batch-only driver (D1 / Neon-HTTP class) that counts how many atomic
// batches it issues. If the gate rejects up front, no batch is ever issued.
class BatchSpyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchesIssued = 0;

  override _executeBatch<T>(
    queries: BatchQuery[],
    options?: TransactionOptions
  ): Promise<QueryResult<T>[]> {
    this.batchesIssued++;
    return super._executeBatch<T>(queries, options);
  }

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

function bootShared<TDriver extends PGliteDriver>(
  driver: TDriver
): VibORMClient<{ schema: BehaviorSchema; driver: TDriver }> {
  return createClient({ schema: nestedWriteBehaviorSchema, driver });
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

async function dumpCounts(client: BehaviorClient): Promise<{
  users: number;
  posts: number;
}> {
  const [users, posts] = await Promise.all([
    client.user.findMany(),
    client.post.findMany(),
  ]);
  return { users: users.length, posts: posts.length };
}

describe("M2 legality gate", () => {
  describe("unsupported nested create keys reject before parent mutation", () => {
    for (const mode of ["transaction", "batch"] as const) {
      test(`${mode} mode persists no rows`, async () => {
        const db = await setupDb();
        const driver =
          mode === "transaction"
            ? new TxSpyDriver({ client: db })
            : new BatchSpyDriver({ client: db });
        const client = bootShared(driver);

        await expect(
          client.user.create({
            data: {
              id: "user-invalid-key",
              name: "Invalid",
              posts: {
                // @ts-expect-error create inputs reject update-only nested keys.
                deleteMany: { title: "Nope" },
              },
            },
          })
        ).rejects.toThrow();

        const counts = await dumpCounts(client);
        expect(counts.users).toBe(0);
        expect(counts.posts).toBe(0);
        await client.$disconnect();
      });
    }
  });

  describe("D5 closed: begin-then-fail input rejected before any execution", () => {
    test("transaction mode rejects before opening a transaction", async () => {
      const db = await setupDb();
      const driver = new TxSpyDriver({ client: db });
      const client = bootShared(driver);

      await client.user.create({
        data: {
          id: "u1",
          name: "A",
          posts: { create: { id: "p1", title: "T" } },
        },
      });
      const txAfterSeed = driver.txOpened;

      await expect(
        client.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", name: "New" },
          update: {
            name: "Changed",
            posts: {
              updateMany: {
                where: {},
                data: { title: "X", author: { connect: { id: "u1" } } },
              },
            },
          },
        })
      ).rejects.toThrow(UPDATE_MANY_RELATION_MESSAGE);

      // The gate rejected before the upsert opened its transaction.
      expect(driver.txOpened - txAfterSeed).toBe(0);

      const user = await client.user.findUnique({ where: { id: "u1" } });
      expect(user?.name).toBe("A");
      await client.$disconnect();
    });

    test("batch mode rejects before issuing a batch, same typed message", async () => {
      const db = await setupDb();
      const driver = new BatchSpyDriver({ client: db });
      const client = bootShared(driver);

      // Seed through the batch path so the row exists for the upsert probe.
      await client.user.create({ data: { id: "u1", name: "A" } });
      await client.post.create({
        data: { id: "p1", title: "T", userId: "u1" },
      });
      const batchesAfterSeed = driver.batchesIssued;

      await expect(
        client.user.upsert({
          where: { id: "u1" },
          create: { id: "u1", name: "New" },
          update: {
            name: "Changed",
            posts: {
              updateMany: {
                where: {},
                data: { title: "X", author: { connect: { id: "u1" } } },
              },
            },
          },
        })
      ).rejects.toThrow(UPDATE_MANY_RELATION_MESSAGE);

      // The gate rejected before the planned engine issued its atomic batch.
      expect(driver.batchesIssued - batchesAfterSeed).toBe(0);

      const user = await client.user.findUnique({ where: { id: "u1" } });
      expect(user?.name).toBe("A");
      await client.$disconnect();
    });
  });
});
