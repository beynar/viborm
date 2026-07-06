/**
 * Batch Transaction Tests
 *
 * Tests for the Prisma-style $transaction([...]) batch API.
 * Verifies that operations can be awaited directly or batched together.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import {
  isPendingOperation,
  PendingOperation,
} from "@client/pending-operation";
import { Driver } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type {
  BatchQuery,
  QueryResult,
  TransactionOptions,
} from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { TransactionError, VibORMErrorCode } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import { batchPrimaryKeyDataflowSchema } from "../fixtures/batch-primary-key-dataflow-schema";

// =============================================================================
// TEST SCHEMA
// =============================================================================

const user = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.oneToMany(() => post),
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
  author: s
    .manyToOne(() => user)
    .fields("authorId")
    .references("id"),
});

const schema = { user, post };

class NoAtomicTransactionDriver extends Driver<unknown, unknown> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  override readonly supportsTransactions = false;
  override readonly supportsBatch = false;

  constructor() {
    super("sqlite", "no-atomic-test");
  }

  protected async initClient(): Promise<unknown> {
    return {};
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    throw new Error("NoAtomicTransactionDriver cannot execute queries");
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    throw new Error("NoAtomicTransactionDriver cannot execute queries");
  }

  protected async transaction<T>(
    _client: unknown,
    fn: (tx: unknown) => Promise<T>,
    _options?: TransactionOptions
  ): Promise<T> {
    return fn({});
  }
}

class BatchOnlyPGliteDriver extends PGliteDriver {
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

type TransactionCapableClient<TClient> = TClient & {
  $transaction<TResult>(
    operation:
      | readonly unknown[]
      | ((tx: TransactionCapableClient<TClient>) => TResult | Promise<TResult>)
  ): Promise<TResult>;
};

const withTransactions = <TClient>(
  client: TClient
): TransactionCapableClient<TClient> =>
  client as TransactionCapableClient<TClient>;

// =============================================================================
// TEST SETUP
// =============================================================================

let db: PGlite;
let client: ReturnType<
  typeof createClient<{ schema: typeof schema; driver: PGliteDriver }>
>;

beforeAll(async () => {
  db = new PGlite();
  const driver = new PGliteDriver({ client: db });
  client = createClient({ schema, driver });

  // Use push() to create tables via the migration engine
  await push(client, { force: true });
});

afterAll(async () => {
  await client.$disconnect();
});

beforeEach(async () => {
  // Clean up data between tests
  await client.$queryRaw(`DELETE FROM "post"`);
  await client.$queryRaw(`DELETE FROM "user"`);
});

// =============================================================================
// TESTS
// =============================================================================

describe("PendingOperation", () => {
  test("model operations return PendingOperation", () => {
    const operation = client.user.findMany();
    expect(isPendingOperation(operation)).toBe(true);
    expect(operation).toBeInstanceOf(PendingOperation);
  });

  test("PendingOperation can be awaited directly", async () => {
    // Create a user first
    await client.user.create({
      data: { id: "1", name: "Alice", email: "alice@test.com" },
    });

    // findMany returns PendingOperation that can be awaited
    const users = await client.user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]!.name).toBe("Alice");
  });

  test("PendingOperation has execute() method", async () => {
    await client.user.create({
      data: { id: "1", name: "Bob", email: "bob@test.com" },
    });

    const operation = client.user.findMany();
    const users = await operation.execute();
    expect(users).toHaveLength(1);
    expect(users[0]!.name).toBe("Bob");
  });

  test("canBatch() returns true for simple operations", () => {
    const findOp = client.user.findMany();
    expect(findOp.canBatch()).toBe(true);

    const createOp = client.user.create({
      data: { id: "1", name: "Test", email: "test@test.com" },
    });
    expect(createOp.canBatch()).toBe(true);
  });

  test("canBatch() returns false for nested writes", () => {
    // Create with nested relation data cannot be precomputed
    // because it requires multiple queries with runtime-dependent values
    const nestedCreateOp = client.user.create({
      data: {
        id: "1",
        name: "Test",
        email: "test@test.com",
        posts: {
          create: [{ id: "p1", title: "Post 1", authorId: "1" }],
        },
      },
    });
    expect(nestedCreateOp.canBatch()).toBe(false);
  });

  test("canBatch() returns false for nested createMany writes", () => {
    const nestedCreateManyOp = client.user.create({
      data: {
        id: "1",
        name: "Test",
        email: "test@test.com",
        posts: {
          createMany: {
            data: [{ id: "p1", title: "Post 1", authorId: "1" }],
          },
        },
      },
    });

    expect(nestedCreateManyOp.canBatch()).toBe(false);
    expect(nestedCreateManyOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for update with nested createMany writes", () => {
    const nestedUpdateOp = client.user.update({
      where: { id: "1" },
      data: {
        posts: {
          createMany: {
            data: [{ id: "p1", title: "Post 1", authorId: "1" }],
          },
        },
      },
    });

    expect(nestedUpdateOp.canBatch()).toBe(false);
    expect(nestedUpdateOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for update with nested connect writes", () => {
    const nestedUpdateOp = client.user.update({
      where: { id: "1" },
      data: {
        posts: {
          connect: { id: "p1" },
        },
      },
    });

    expect(nestedUpdateOp.canBatch()).toBe(false);
    expect(nestedUpdateOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for update with nested connectOrCreate writes", () => {
    const nestedUpdateOp = client.user.update({
      where: { id: "1" },
      data: {
        posts: {
          connectOrCreate: {
            where: { id: "p1" },
            create: {
              id: "p1",
              title: "Post 1",
              authorId: "1",
            },
          },
        },
      },
    });

    expect(nestedUpdateOp.canBatch()).toBe(false);
    expect(nestedUpdateOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for upsert with nested create writes in create branch", () => {
    const nestedUpsertOp = client.user.upsert({
      where: { id: "1" },
      create: {
        id: "1",
        name: "Test",
        email: "test@test.com",
        posts: {
          create: [{ id: "p1", title: "Post 1", authorId: "1" }],
        },
      },
      update: { name: "Updated" },
    });

    expect(nestedUpsertOp.canBatch()).toBe(false);
    expect(nestedUpsertOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for upsert with nested createMany writes in update branch", () => {
    const nestedUpsertOp = client.user.upsert({
      where: { id: "1" },
      create: {
        id: "1",
        name: "Test",
        email: "test@test.com",
      },
      update: {
        posts: {
          createMany: {
            data: [{ id: "p1", title: "Post 1", authorId: "1" }],
          },
        },
      },
    });

    expect(nestedUpsertOp.canBatch()).toBe(false);
    expect(nestedUpsertOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns false for upsert with nested connect writes", () => {
    const nestedUpsertOp = client.user.upsert({
      where: { id: "1" },
      create: {
        id: "1",
        name: "Test",
        email: "test@test.com",
      },
      update: {
        posts: {
          connect: { id: "p1" },
        },
      },
    });

    expect(nestedUpsertOp.canBatch()).toBe(false);
    expect(nestedUpsertOp.prepare()).toBeUndefined();
  });

  test("canBatch() returns true for simple create without nested writes", () => {
    const simpleCreateOp = client.user.create({
      data: { id: "1", name: "Test", email: "test@test.com" },
    });
    expect(simpleCreateOp.canBatch()).toBe(true);
  });
});

describe("$transaction with callback", () => {
  test("executes operations within a transaction", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "1", name: "Charlie", email: "charlie@test.com" },
      });
      await tx.post.create({
        data: { id: "1", title: "Hello World", authorId: "1" },
      });
    });

    const users = await client.user.findMany();
    const posts = await client.post.findMany();
    expect(users).toHaveLength(1);
    expect(posts).toHaveLength(1);
  });

  test("rolls back on error", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "1", name: "Dave", email: "dave@test.com" },
        });
        // This should fail due to duplicate email
        await tx.user.create({
          data: { id: "2", name: "Dave2", email: "dave@test.com" },
        });
      });
    } catch {
      // Expected to fail
    }

    // Neither user should be created due to rollback
    const users = await client.user.findMany();
    expect(users).toHaveLength(0);
  });

  test("enforces transaction timeout and rolls back", async () => {
    await expect(
      withTransactions(client).$transaction(
        async (tx) => {
          await tx.user.create({
            data: {
              id: "timeout-user",
              name: "Timeout",
              email: "timeout@test.com",
            },
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
        },
        { timeout: 5 }
      )
    ).rejects.toMatchObject({
      name: "TransactionError",
      code: VibORMErrorCode.TRANSACTION_TIMEOUT,
    });

    const users = await client.user.findMany({
      where: { id: "timeout-user" },
    });
    expect(users).toHaveLength(0);
  });

  test("transaction timeout rejects late callback queries", async () => {
    let lateWriteError: unknown;
    let resolveLateWrite: (() => void) | undefined;
    const lateWriteFinished = new Promise<void>((resolve) => {
      resolveLateWrite = resolve;
    });

    await expect(
      withTransactions(client).$transaction(
        async (tx) => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          try {
            await tx.user.create({
              data: {
                id: "late-timeout-user",
                name: "Late Timeout",
                email: "late-timeout@test.com",
              },
            });
          } catch (error) {
            lateWriteError = error;
          } finally {
            resolveLateWrite?.();
          }
        },
        { timeout: 5 }
      )
    ).rejects.toMatchObject({
      name: "TransactionError",
      code: VibORMErrorCode.TRANSACTION_TIMEOUT,
    });

    await lateWriteFinished;
    expect(lateWriteError).toMatchObject({
      name: "TransactionError",
      code: VibORMErrorCode.TRANSACTION_TIMEOUT,
    });

    const users = await client.user.findMany({
      where: { id: "late-timeout-user" },
    });
    expect(users).toHaveLength(0);
  });

  test("rejects callback transactions for non-atomic drivers", async () => {
    const nonAtomicClient = createClient({
      schema,
      driver: new NoAtomicTransactionDriver(),
    });

    await expect(
      withTransactions(nonAtomicClient).$transaction(async () => "unused")
    ).rejects.toBeInstanceOf(TransactionError);

    await nonAtomicClient.$disconnect();
  });
});

describe("$transaction with array (batch mode)", () => {
  test("executes multiple operations atomically", async () => {
    // Create users first
    await client.user.create({
      data: { id: "1", name: "Eve", email: "eve@test.com" },
    });
    await client.user.create({
      data: { id: "2", name: "Frank", email: "frank@test.com" },
    });

    // Batch read operations
    const [users, posts] = await withTransactions(client).$transaction([
      client.user.findMany(),
      client.post.findMany(),
    ]);

    expect(users).toHaveLength(2);
    expect(posts).toHaveLength(0);
  });

  test("batches write operations", async () => {
    const [user1, user2] = await withTransactions(client).$transaction([
      client.user.create({
        data: { id: "1", name: "Grace", email: "grace@test.com" },
      }),
      client.user.create({
        data: { id: "2", name: "Henry", email: "henry@test.com" },
      }),
    ]);

    expect(user1.name).toBe("Grace");
    expect(user2.name).toBe("Henry");

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(2);
  });

  test("batch-only driver batches nested write operations atomically", async () => {
    const batchDb = new PGlite();
    const setupClient = createClient({
      schema,
      driver: new PGliteDriver({ client: batchDb }),
    });
    const batchOnlyClient = createClient({
      schema,
      driver: new BatchOnlyPGliteDriver({ client: batchDb }),
    });

    try {
      await push(setupClient, { force: true });
      await setupClient.user.create({
        data: { id: "1", name: "Nested", email: "nested@test.com" },
      });

      const [updatedUser, postCount] = await withTransactions(
        batchOnlyClient
      ).$transaction([
        batchOnlyClient.user.update({
          where: { id: "1" },
          data: {
            name: "Nested Updated",
            posts: {
              create: { id: "p1", title: "Nested post" },
            },
          },
        }),
        batchOnlyClient.post.count(),
      ]);

      expect(updatedUser.name).toBe("Nested Updated");
      expect(postCount).toBe(1);

      const posts = await batchOnlyClient.post.findMany();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.authorId).toBe("1");
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only driver flattens generated-id nested plans and keeps result order", async () => {
    const batchDb = new PGlite();
    const setupClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new PGliteDriver({ client: batchDb }),
    });
    const batchOnlyClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new BatchOnlyPGliteDriver({ client: batchDb }),
    });

    try {
      await push(setupClient, { force: true });

      const [generatedUser, mutableUser, generatedPostCount] =
        await withTransactions(batchOnlyClient).$transaction([
          batchOnlyClient.generatedUser.create({
            data: {
              name: "Transaction generated",
              featuredChildId: null,
              posts: {
                create: {
                  title: "Transaction generated child",
                  slug: "transaction-generated-child",
                },
              },
            },
          }),
          batchOnlyClient.mutableUser.create({
            data: { id: 5000, name: "Transaction mutable" },
          }),
          batchOnlyClient.generatedPost.count(),
        ]);

      expect(generatedUser.name).toBe("Transaction generated");
      expect(mutableUser.id).toBe(5000);
      expect(generatedPostCount).toBe(1);

      const post = await batchOnlyClient.generatedPost.findFirst();
      expect(post?.userId).toBe(generatedUser.id);
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only driver flattens generated and updated primary-key nested plans", async () => {
    const batchDb = new PGlite();
    const setupClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new PGliteDriver({ client: batchDb }),
    });
    const batchOnlyClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new BatchOnlyPGliteDriver({ client: batchDb }),
    });

    try {
      await push(setupClient, { force: true });
      await batchOnlyClient.mutableUser.create({
        data: { id: 6000, name: "Mutable source" },
      });

      const [generatedUser, mutableCount, updatedUser, generatedPostCount] =
        await withTransactions(batchOnlyClient).$transaction([
          batchOnlyClient.generatedUser.create({
            data: {
              name: "Flatten generated",
              featuredChildId: null,
              posts: {
                create: {
                  title: "Flatten generated child",
                  slug: "flatten-generated-child",
                },
              },
            },
          }),
          batchOnlyClient.mutableUser.count(),
          batchOnlyClient.mutableUser.update({
            where: { id: 6000 },
            data: {
              id: { increment: 25 },
              name: "Mutable moved",
              posts: {
                create: { title: "Mutable moved child" },
              },
            },
          }),
          batchOnlyClient.generatedPost.count(),
        ]);

      expect(generatedUser.name).toBe("Flatten generated");
      expect(mutableCount).toBe(1);
      expect(updatedUser.id).toBe(6025);
      expect(generatedPostCount).toBe(1);

      const [generatedPost, mutablePost] = await Promise.all([
        batchOnlyClient.generatedPost.findFirst(),
        batchOnlyClient.mutablePost.findFirst(),
      ]);
      expect(generatedPost?.userId).toBe(generatedUser.id);
      expect(mutablePost?.userId).toBe(6025);
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("batch-only transaction rolls back earlier generated refs when a later nested plan fails", { timeout: 30_000 }, async () => {
    const batchDb = new PGlite();
    const setupClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new PGliteDriver({ client: batchDb }),
    });
    const batchOnlyClient = createClient({
      schema: batchPrimaryKeyDataflowSchema,
      driver: new BatchOnlyPGliteDriver({ client: batchDb }),
    });

    try {
      await push(setupClient, { force: true });

      await expect(
        withTransactions(batchOnlyClient).$transaction([
          batchOnlyClient.generatedUser.create({
            data: {
              name: "Earlier generated",
              featuredChildId: null,
              posts: {
                create: {
                  title: "Earlier child",
                  slug: "earlier-generated-child",
                },
              },
            },
          }),
          batchOnlyClient.generatedUser.create({
            data: {
              name: "Later failing generated",
              featuredChildId: null,
              posts: {
                create: [
                  { title: "Duplicate one", slug: "duplicate-flattened" },
                  { title: "Duplicate two", slug: "duplicate-flattened" },
                ],
              },
            },
          }),
        ])
      ).rejects.toThrow();

      const [users, posts] = await Promise.all([
        batchOnlyClient.generatedUser.findMany(),
        batchOnlyClient.generatedPost.findMany(),
      ]);
      expect(users).toHaveLength(0);
      expect(posts).toHaveLength(0);
    } finally {
      await batchOnlyClient.$disconnect();
    }
  });

  test("returns results in correct order", async () => {
    await client.user.create({
      data: { id: "1", name: "Ivy", email: "ivy@test.com" },
    });

    const [count, users, firstUser] = await withTransactions(
      client
    ).$transaction([
      client.user.count(),
      client.user.findMany(),
      client.user.findFirst(),
    ]);

    expect(count).toBe(1);
    expect(users).toHaveLength(1);
    expect(firstUser?.name).toBe("Ivy");
  });

  test("rejects non-PendingOperation items", async () => {
    await expect(
      withTransactions(client).$transaction([
        Promise.resolve("not a pending operation"),
      ])
    ).rejects.toThrow(
      "$transaction array must contain only pending operations from client methods"
    );
  });

  test("rejects batch transactions when the driver has no atomic mode", async () => {
    const nonAtomicClient = createClient({
      schema,
      driver: new NoAtomicTransactionDriver(),
    });

    await expect(
      withTransactions(nonAtomicClient).$transaction([
        nonAtomicClient.user.findMany(),
      ])
    ).rejects.toBeInstanceOf(TransactionError);

    await nonAtomicClient.$disconnect();
  });

  test("supports transaction options (isolation level)", async () => {
    // Batch mode should accept and pass through transaction options
    const [user] = await withTransactions(client).$transaction(
      [
        client.user.create({
          data: { id: "1", name: "IsolationTest", email: "iso@test.com" },
        }),
      ],
      { isolationLevel: "serializable" }
    );

    expect(user.name).toBe("IsolationTest");

    // Verify the user was actually created
    const found = await client.user.findUnique({ where: { id: "1" } });
    expect(found?.name).toBe("IsolationTest");
  });
});

describe("mixed operations", () => {
  test("operations work independently after batch", async () => {
    // Batch some operations
    await withTransactions(client).$transaction([
      client.user.create({
        data: { id: "1", name: "Jack", email: "jack@test.com" },
      }),
    ]);

    // Regular operation should still work
    const user = await client.user.findFirst({ where: { id: "1" } });
    expect(user?.name).toBe("Jack");

    // Another batch
    await withTransactions(client).$transaction([
      client.user.update({
        where: { id: "1" },
        data: { name: "Jack Updated" },
      }),
    ]);

    const updatedUser = await client.user.findFirst({ where: { id: "1" } });
    expect(updatedUser?.name).toBe("Jack Updated");
  });
});

// =============================================================================
// CONCURRENT TRANSACTIONS
// =============================================================================

describe("concurrent transactions", () => {
  test("multiple transactions can run in parallel without interference", async () => {
    // Run 3 transactions concurrently, each creating a different user
    const results = await Promise.all([
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "concurrent-1", name: "User 1", email: "user1@test.com" },
        });
        return tx.user.findUnique({ where: { id: "concurrent-1" } });
      }),
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "concurrent-2", name: "User 2", email: "user2@test.com" },
        });
        return tx.user.findUnique({ where: { id: "concurrent-2" } });
      }),
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "concurrent-3", name: "User 3", email: "user3@test.com" },
        });
        return tx.user.findUnique({ where: { id: "concurrent-3" } });
      }),
    ]);

    // Each transaction should have returned its own user
    expect(results[0]?.name).toBe("User 1");
    expect(results[1]?.name).toBe("User 2");
    expect(results[2]?.name).toBe("User 3");

    // All users should exist in the database
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(3);
  });

  test("one failing transaction does not affect others", async () => {
    // Create a user first to cause a conflict
    await client.user.create({
      data: { id: "existing", name: "Existing", email: "existing@test.com" },
    });

    const results = await Promise.allSettled([
      // This one will succeed
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "success-1",
            name: "Success 1",
            email: "success1@test.com",
          },
        });
        return "success-1";
      }),
      // This one will fail due to duplicate email
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "fail-1", name: "Fail 1", email: "existing@test.com" },
        });
        return "fail-1";
      }),
      // This one will succeed
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "success-2",
            name: "Success 2",
            email: "success2@test.com",
          },
        });
        return "success-2";
      }),
    ]);

    // Check results
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");

    // Only successful transactions should have committed
    const allUsers = await client.user.findMany();
    const userIds = allUsers.map((u) => u.id).sort();
    expect(userIds).toEqual(["existing", "success-1", "success-2"]);
  });

  test("concurrent batch transactions work correctly", async () => {
    const results = await Promise.all([
      withTransactions(client).$transaction([
        client.user.create({
          data: { id: "batch-1", name: "Batch 1", email: "batch1@test.com" },
        }),
      ]),
      withTransactions(client).$transaction([
        client.user.create({
          data: { id: "batch-2", name: "Batch 2", email: "batch2@test.com" },
        }),
      ]),
    ]);

    expect(results[0][0].name).toBe("Batch 1");
    expect(results[1][0].name).toBe("Batch 2");

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(2);
  });
});

// =============================================================================
// SEQUENTIAL OPERATIONS IN TRANSACTION
// =============================================================================

describe("sequential operations in transaction", () => {
  test("multiple sequential creates in transaction", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "seq-1", name: "User 1", email: "seq1@test.com" },
      });
      await tx.user.create({
        data: { id: "seq-2", name: "User 2", email: "seq2@test.com" },
      });
      await tx.user.create({
        data: { id: "seq-3", name: "User 3", email: "seq3@test.com" },
      });
    });

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(3);
    expect(allUsers.map((u) => u.id).sort()).toEqual([
      "seq-1",
      "seq-2",
      "seq-3",
    ]);
  });

  test("read-after-write within transaction sees uncommitted changes", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "raw-1", name: "RAW User", email: "raw@test.com" },
      });

      // Should see the uncommitted user within the same transaction
      const user = await tx.user.findUnique({ where: { id: "raw-1" } });
      expect(user).not.toBeNull();
      expect(user?.name).toBe("RAW User");
    });
  });

  test("update after create within transaction", async () => {
    const result = await withTransactions(client).$transaction(async (tx) => {
      const created = await tx.user.create({
        data: { id: "update-1", name: "Original", email: "update@test.com" },
      });

      const updated = await tx.user.update({
        where: { id: created.id },
        data: { name: "Updated" },
      });

      return updated;
    });

    expect(result.name).toBe("Updated");

    const user = await client.user.findUnique({ where: { id: "update-1" } });
    expect(user?.name).toBe("Updated");
  });

  test("delete after create within transaction", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "delete-1", name: "To Delete", email: "delete@test.com" },
      });

      await tx.user.delete({ where: { id: "delete-1" } });
    });

    const user = await client.user.findUnique({ where: { id: "delete-1" } });
    expect(user).toBeNull();
  });
});

// =============================================================================
// ERROR SCENARIOS
// =============================================================================

describe("error scenarios", () => {
  test("constraint violation triggers rollback in callback mode", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "error-1",
            name: "Error User 1",
            email: "error@test.com",
          },
        });
        await tx.user.create({
          data: {
            id: "error-2",
            name: "Error User 2",
            email: "error2@test.com",
          },
        });
        // Violate unique constraint
        await tx.user.create({
          data: {
            id: "error-3",
            name: "Error User 3",
            email: "error@test.com",
          },
        });
      });
    } catch {
      // Expected
    }

    // All operations should be rolled back
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(0);
  });

  test("constraint violation in batch mode triggers rollback", async () => {
    // Create a user to cause conflict
    await client.user.create({
      data: {
        id: "existing-batch",
        name: "Existing",
        email: "existingbatch@test.com",
      },
    });

    try {
      await withTransactions(client).$transaction([
        client.user.create({
          data: {
            id: "batch-new-1",
            name: "New 1",
            email: "batchnew1@test.com",
          },
        }),
        client.user.create({
          data: {
            id: "batch-new-2",
            name: "New 2",
            email: "existingbatch@test.com",
          }, // Conflict
        }),
      ]);
    } catch {
      // Expected
    }

    // Only the pre-existing user should remain
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(1);
    expect(allUsers[0]?.id).toBe("existing-batch");
  });

  test("thrown error in transaction callback triggers rollback", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "thrown-1",
            name: "Thrown User",
            email: "thrown@test.com",
          },
        });
        throw new Error("Intentional error after create");
      });
    } catch {
      // Expected
    }

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(0);
  });

  test("async error in transaction callback triggers rollback", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "async-err-1",
            name: "Async Error User",
            email: "asyncerr@test.com",
          },
        });
        // Simulate async error
        await new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Async error")), 10)
        );
      });
    } catch {
      // Expected
    }

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(0);
  });

  test("error message is preserved when transaction fails", async () => {
    const errorMessage = "Custom error message for testing";

    await expect(
      withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "preserve-1",
            name: "Preserve",
            email: "preserve@test.com",
          },
        });
        throw new Error(errorMessage);
      })
    ).rejects.toThrow(errorMessage);
  });

  test("transaction returns value on success", async () => {
    const result = await withTransactions(client).$transaction(async (tx) => {
      const user = await tx.user.create({
        data: { id: "return-1", name: "Return User", email: "return@test.com" },
      });
      return { created: true, userId: user.id };
    });

    expect(result).toEqual({ created: true, userId: "return-1" });
  });
});

// =============================================================================
// TRANSACTION SEMANTICS
// =============================================================================

describe("transaction semantics", () => {
  test("changes are visible after commit", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: "commit-1",
          name: "Committed User",
          email: "commit@test.com",
        },
      });
    });

    // After transaction completes, changes should be visible
    const user = await client.user.findUnique({ where: { id: "commit-1" } });
    expect(user).not.toBeNull();
    expect(user?.name).toBe("Committed User");
  });

  test("changes are not visible after rollback", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "rollback-1",
            name: "Rolled Back User",
            email: "rollback@test.com",
          },
        });
        throw new Error("Force rollback");
      });
    } catch {
      // Expected
    }

    // After rollback, changes should not be visible
    const user = await client.user.findUnique({ where: { id: "rollback-1" } });
    expect(user).toBeNull();
  });

  test("transaction sees its own uncommitted changes", async () => {
    let sawOwnChanges = false;

    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "self-1", name: "Self User", email: "self@test.com" },
      });

      // Query within same transaction should see uncommitted data
      const user = await tx.user.findUnique({ where: { id: "self-1" } });
      sawOwnChanges = user !== null;
    });

    expect(sawOwnChanges).toBe(true);
  });

  test("transaction can read and update same record", async () => {
    // Create initial data
    await client.user.create({
      data: {
        id: "read-update-1",
        name: "Original",
        email: "readupdate@test.com",
      },
    });

    await withTransactions(client).$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: "read-update-1" } });
      expect(user?.name).toBe("Original");

      await tx.user.update({
        where: { id: "read-update-1" },
        data: { name: "Modified" },
      });

      const updated = await tx.user.findUnique({
        where: { id: "read-update-1" },
      });
      expect(updated?.name).toBe("Modified");
    });

    const final = await client.user.findUnique({
      where: { id: "read-update-1" },
    });
    expect(final?.name).toBe("Modified");
  });
});

// =============================================================================
// NESTED TRANSACTIONS (SAVEPOINTS)
// =============================================================================

describe("nested transactions", () => {
  test("nested transaction commits when both succeed", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "outer-1", name: "Outer User", email: "outer@test.com" },
      });

      await withTransactions(tx).$transaction(async (nestedTx) => {
        await nestedTx.user.create({
          data: {
            id: "nested-1",
            name: "Nested User",
            email: "nested@test.com",
          },
        });
      });
    });

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(2);
    expect(allUsers.map((u) => u.id).sort()).toEqual(["nested-1", "outer-1"]);
  });

  test("nested transaction rollback does not affect outer transaction", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: "outer-only",
          name: "Outer Only",
          email: "outeronly@test.com",
        },
      });

      // Nested transaction that fails - should only rollback nested changes
      try {
        await withTransactions(tx).$transaction(async (nestedTx) => {
          await nestedTx.user.create({
            data: {
              id: "nested-fail",
              name: "Nested Fail",
              email: "nestedfail@test.com",
            },
          });
          throw new Error("Nested transaction error");
        });
      } catch {
        // Expected - nested transaction failed
      }

      // Outer transaction continues - create another user
      await tx.user.create({
        data: {
          id: "outer-after",
          name: "Outer After",
          email: "outerafter@test.com",
        },
      });
    });

    // Only outer users should exist, nested-fail should be rolled back
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(2);
    expect(allUsers.map((u) => u.id).sort()).toEqual([
      "outer-after",
      "outer-only",
    ]);
  });

  test("outer transaction rollback also rolls back nested commits", async () => {
    try {
      await withTransactions(client).$transaction(async (tx) => {
        await tx.user.create({
          data: {
            id: "outer-rollback",
            name: "Outer Rollback",
            email: "outerrollback@test.com",
          },
        });

        // Nested transaction succeeds
        await withTransactions(tx).$transaction(async (nestedTx) => {
          await nestedTx.user.create({
            data: {
              id: "nested-rollback",
              name: "Nested Rollback",
              email: "nestedrollback@test.com",
            },
          });
        });

        // Outer transaction fails after nested succeeds
        throw new Error("Outer transaction error");
      });
    } catch {
      // Expected
    }

    // Both users should be rolled back
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(0);
  });

  test("deeply nested transactions work correctly", async () => {
    await withTransactions(client).$transaction(async (tx1) => {
      await tx1.user.create({
        data: { id: "level-1", name: "Level 1", email: "level1@test.com" },
      });

      await withTransactions(tx1).$transaction(async (tx2) => {
        await tx2.user.create({
          data: { id: "level-2", name: "Level 2", email: "level2@test.com" },
        });

        await withTransactions(tx2).$transaction(async (tx3) => {
          await tx3.user.create({
            data: { id: "level-3", name: "Level 3", email: "level3@test.com" },
          });
        });
      });
    });

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(3);
    expect(allUsers.map((u) => u.id).sort()).toEqual([
      "level-1",
      "level-2",
      "level-3",
    ]);
  });

  test("nested transaction can read changes from outer transaction", async () => {
    let nestedSawOuterChanges = false;

    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: "outer-visible",
          name: "Outer Visible",
          email: "outervisible@test.com",
        },
      });

      await withTransactions(tx).$transaction(async (nestedTx) => {
        // Should see uncommitted changes from outer transaction
        const user = await nestedTx.user.findUnique({
          where: { id: "outer-visible" },
        });
        nestedSawOuterChanges = user !== null;
      });
    });

    expect(nestedSawOuterChanges).toBe(true);
  });
});

// =============================================================================
// CONCURRENT NESTED TRANSACTIONS
// =============================================================================

describe("concurrent nested transactions", () => {
  // Concurrent nested transactions are automatically serialized by SavepointQueue
  // to prevent savepoint stack conflicts. Users can safely use Promise.all().

  test("multiple concurrent nested transactions in same outer transaction", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: "outer-concurrent",
          name: "Outer",
          email: "outerconcurrent@test.com",
        },
      });

      // Run multiple nested transactions concurrently - SavepointQueue serializes them
      await Promise.all([
        withTransactions(tx).$transaction(async (nested1) => {
          await nested1.user.create({
            data: {
              id: "concurrent-nested-1",
              name: "Concurrent Nested 1",
              email: "cn1@test.com",
            },
          });
        }),
        withTransactions(tx).$transaction(async (nested2) => {
          await nested2.user.create({
            data: {
              id: "concurrent-nested-2",
              name: "Concurrent Nested 2",
              email: "cn2@test.com",
            },
          });
        }),
        withTransactions(tx).$transaction(async (nested3) => {
          await nested3.user.create({
            data: {
              id: "concurrent-nested-3",
              name: "Concurrent Nested 3",
              email: "cn3@test.com",
            },
          });
        }),
      ]);
    });

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(4);
  });

  test("one failing concurrent nested transaction does not affect others", async () => {
    await withTransactions(client).$transaction(async (tx) => {
      await tx.user.create({
        data: {
          id: "outer-mixed",
          name: "Outer Mixed",
          email: "outermixed@test.com",
        },
      });

      const results = await Promise.allSettled([
        withTransactions(tx).$transaction(async (nested1) => {
          await nested1.user.create({
            data: {
              id: "mixed-success-1",
              name: "Mixed Success 1",
              email: "ms1@test.com",
            },
          });
          return "success-1";
        }),
        withTransactions(tx).$transaction(async (nested2) => {
          await nested2.user.create({
            data: {
              id: "mixed-fail",
              name: "Mixed Fail",
              email: "mf@test.com",
            },
          });
          throw new Error("Intentional nested failure");
        }),
        withTransactions(tx).$transaction(async (nested3) => {
          await nested3.user.create({
            data: {
              id: "mixed-success-2",
              name: "Mixed Success 2",
              email: "ms2@test.com",
            },
          });
          return "success-2";
        }),
      ]);

      expect(results[0].status).toBe("fulfilled");
      expect(results[1].status).toBe("rejected");
      expect(results[2].status).toBe("fulfilled");
    });

    // Outer + 2 successful nested transactions (mixed-fail was rolled back)
    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(3);
    const userIds = allUsers.map((u) => u.id).sort();
    expect(userIds).toEqual([
      "mixed-success-1",
      "mixed-success-2",
      "outer-mixed",
    ]);
  });

  test("concurrent outer transactions with nested transactions", async () => {
    const results = await Promise.all([
      withTransactions(client).$transaction(async (tx1) => {
        await tx1.user.create({
          data: {
            id: "parallel-outer-1",
            name: "Parallel Outer 1",
            email: "po1@test.com",
          },
        });
        await withTransactions(tx1).$transaction(async (nested) => {
          await nested.user.create({
            data: {
              id: "parallel-nested-1",
              name: "Parallel Nested 1",
              email: "pn1@test.com",
            },
          });
        });
        return "tx1-done";
      }),
      withTransactions(client).$transaction(async (tx2) => {
        await tx2.user.create({
          data: {
            id: "parallel-outer-2",
            name: "Parallel Outer 2",
            email: "po2@test.com",
          },
        });
        await withTransactions(tx2).$transaction(async (nested) => {
          await nested.user.create({
            data: {
              id: "parallel-nested-2",
              name: "Parallel Nested 2",
              email: "pn2@test.com",
            },
          });
        });
        return "tx2-done";
      }),
    ]);

    expect(results).toEqual(["tx1-done", "tx2-done"]);

    const allUsers = await client.user.findMany();
    expect(allUsers).toHaveLength(4);
  });
});
