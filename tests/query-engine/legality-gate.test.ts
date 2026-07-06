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
 * `assertPlanExecutable` routes the static validation through one throw site,
 * before either old engine runs, in BOTH modes. The gate proves:
 *  - the "unsupported nested create keys reject before parent mutation"
 *    contract holds in both modes (0 rows persisted);
 *  - a top-level upsert's branch validation stays runtime-branch-gated. Both
 *    frozen substrates validate ONLY the branch they take (§6.1, §9): the
 *    update branch when the target exists, the create branch when it is absent.
 *    The static gate cannot run the existence probe, so it must NOT hoist
 *    either branch's check — doing so would reject an input the frozen engines
 *    accept (a missing-target upsert whose never-executed update branch nests
 *    an unsupported relation write), a new rejection barred by the freeze rule
 *    (§11) and Pin Rule 2 (§5.5). The frozen engines still reject the update
 *    branch when it is actually taken, with the same typed message in both
 *    modes; that branch-scoped check lands in the interpreter at M6.
 */

type BehaviorSchema = typeof nestedWriteBehaviorSchema;

type BehaviorClient = VibORMClient<{
  schema: BehaviorSchema;
  driver: PGliteDriver;
}>;

const UPDATE_MANY_RELATION_MESSAGE =
  "Nested relation writes inside updateMany data for relation 'posts' are not supported.";

// A tx driver that counts how many transactions it opens, so a test can prove
// an operation reached the atomic scope (was not short-circuited by the gate).
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

// A batch-only driver (D1 / Neon-HTTP class): forces the planned (batch)
// substrate on a PGlite-backed connection so both modes are exercised.
class BatchSpyDriver extends PGliteDriver {
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
      test(`${mode} mode persists no rows`, { timeout: 30_000 }, async () => {
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

  // A top-level upsert takes one branch at runtime, decided by an existence
  // probe. The gate must NOT statically validate a branch that may never run,
  // or it rejects inputs the frozen engines accept.
  describe("upsert branch validation stays runtime-branch-gated", () => {
    // Regression guard for the M2 over-rejection: a MISSING-target upsert takes
    // the create branch, so its update branch never runs and is never
    // validated. The frozen engines create the row and succeed; the gate must
    // not pre-reject it. The spy proves the operation actually executed (it was
    // not short-circuited by a static throw).
    test("transaction mode: missing target with invalid update branch succeeds", { timeout: 30_000 }, async () => {
      const db = await setupDb();
      const driver = new TxSpyDriver({ client: db });
      const client = bootShared(driver);
      const txBefore = driver.txOpened;

      const created = await client.user.upsert({
        where: { id: "u-new" },
        create: { id: "u-new", name: "Created" },
        update: {
          name: "Never",
          posts: {
            updateMany: {
              where: {},
              data: { title: "X", author: { connect: { id: "u-new" } } },
            },
          },
        },
      });

      expect(created.name).toBe("Created");
      // The create branch ran inside an atomic scope — not short-circuited.
      expect(driver.txOpened - txBefore).toBeGreaterThan(0);
      const counts = await dumpCounts(client);
      expect(counts.users).toBe(1);
      await client.$disconnect();
    });

    test("batch mode: missing target with invalid update branch succeeds", { timeout: 30_000 }, async () => {
      const db = await setupDb();
      const driver = new BatchSpyDriver({ client: db });
      const client = bootShared(driver);

      const created = await client.user.upsert({
        where: { id: "u-new" },
        create: { id: "u-new", name: "Created" },
        update: {
          name: "Never",
          posts: {
            updateMany: {
              where: {},
              data: { title: "X", author: { connect: { id: "u-new" } } },
            },
          },
        },
      });

      expect(created.name).toBe("Created");
      const counts = await dumpCounts(client);
      expect(counts.users).toBe(1);
      await client.$disconnect();
    });

    // The update branch IS validated when it is actually taken (target
    // exists) — by the frozen engines, with the identical typed message in
    // both modes, and with no partial state persisted.
    test("transaction mode: existing target rejects the taken update branch", { timeout: 30_000 }, async () => {
      const db = await setupDb();
      const driver = new TxSpyDriver({ client: db });
      const client = bootShared(driver);
      await client.user.create({ data: { id: "u1", name: "A" } });

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

      const user = await client.user.findUnique({ where: { id: "u1" } });
      expect(user?.name).toBe("A");
      await client.$disconnect();
    });

    test("batch mode: existing target rejects the taken update branch, same message", { timeout: 30_000 }, async () => {
      const db = await setupDb();
      const driver = new BatchSpyDriver({ client: db });
      const client = bootShared(driver);
      await client.user.create({ data: { id: "u1", name: "A" } });
      await client.post.create({
        data: { id: "p1", title: "T", userId: "u1" },
      });

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

      const user = await client.user.findUnique({ where: { id: "u1" } });
      expect(user?.name).toBe("A");
      await client.$disconnect();
    });
  });
});
