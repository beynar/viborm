/**
 * Batch Transaction Tests
 *
 * Tests for the Prisma-style $transaction([...]) batch API.
 * Verifies that operations can be awaited directly or batched together.
 */

import { PGlite } from "@electric-sql/pglite";
import { isPendingOperation, PendingOperation } from "@client/pending-operation";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { s } from "@schema";
import { describe, expect, test, beforeAll, afterAll, beforeEach } from "vitest";

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
  author: s.manyToOne(() => user).fields("authorId").references("id"),
});

const schema = { user, post };

// =============================================================================
// TEST SETUP
// =============================================================================

let db: PGlite;
let client: ReturnType<typeof createClient<{ schema: typeof schema; driver: PGliteDriver }>>;

beforeAll(async () => {
  db = new PGlite();
  const driver = new PGliteDriver({ client: db });
  client = createClient({ schema, driver });

  // Create tables manually for tests
  await client.$queryRaw(`
    CREATE TABLE IF NOT EXISTS "user" (
      "id" TEXT PRIMARY KEY,
      "name" TEXT NOT NULL,
      "email" TEXT NOT NULL UNIQUE
    )
  `);
  await client.$queryRaw(`
    CREATE TABLE IF NOT EXISTS "post" (
      "id" TEXT PRIMARY KEY,
      "title" TEXT NOT NULL,
      "authorId" TEXT NOT NULL
    )
  `);
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

  test("getSqlString() returns precomputed SQL", () => {
    const operation = client.user.findMany();
    const sql = operation.getSqlString("$n");
    expect(sql).toBeTruthy();
    expect(sql).toContain("SELECT");
    expect(sql).toContain('"user"');
  });

  test("getParams() returns query parameters", () => {
    const operation = client.user.findUnique({ where: { id: "123" } });
    const params = operation.getParams();
    expect(params).toContain("123");
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

  test("canBatch() returns true for simple create without nested writes", () => {
    const simpleCreateOp = client.user.create({
      data: { id: "1", name: "Test", email: "test@test.com" },
    });
    expect(simpleCreateOp.canBatch()).toBe(true);
  });
});

describe("$transaction with callback", () => {
  test("executes operations within a transaction", async () => {
    await client.$transaction(async (tx) => {
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
      await client.$transaction(async (tx) => {
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
    const [users, posts] = await client.$transaction([
      client.user.findMany(),
      client.post.findMany(),
    ]);

    expect(users).toHaveLength(2);
    expect(posts).toHaveLength(0);
  });

  test("batches write operations", async () => {
    const [user1, user2] = await client.$transaction([
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

  test("returns results in correct order", async () => {
    await client.user.create({
      data: { id: "1", name: "Ivy", email: "ivy@test.com" },
    });

    const [count, users, firstUser] = await client.$transaction([
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
      // @ts-expect-error - intentionally passing wrong type
      client.$transaction([Promise.resolve("not a pending operation")])
    ).rejects.toThrow(
      "$transaction array must contain only pending operations from client methods"
    );
  });
});

describe("mixed operations", () => {
  test("operations work independently after batch", async () => {
    // Batch some operations
    await client.$transaction([
      client.user.create({
        data: { id: "1", name: "Jack", email: "jack@test.com" },
      }),
    ]);

    // Regular operation should still work
    const user = await client.user.findFirst({ where: { id: "1" } });
    expect(user?.name).toBe("Jack");

    // Another batch
    await client.$transaction([
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
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "concurrent-1", name: "User 1", email: "user1@test.com" },
        });
        return tx.user.findUnique({ where: { id: "concurrent-1" } });
      }),
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "concurrent-2", name: "User 2", email: "user2@test.com" },
        });
        return tx.user.findUnique({ where: { id: "concurrent-2" } });
      }),
      client.$transaction(async (tx) => {
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
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "success-1", name: "Success 1", email: "success1@test.com" },
        });
        return "success-1";
      }),
      // This one will fail due to duplicate email
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "fail-1", name: "Fail 1", email: "existing@test.com" },
        });
        return "fail-1";
      }),
      // This one will succeed
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "success-2", name: "Success 2", email: "success2@test.com" },
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
      client.$transaction([
        client.user.create({
          data: { id: "batch-1", name: "Batch 1", email: "batch1@test.com" },
        }),
      ]),
      client.$transaction([
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
    await client.$transaction(async (tx) => {
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
    expect(allUsers.map((u) => u.id).sort()).toEqual(["seq-1", "seq-2", "seq-3"]);
  });

  test("read-after-write within transaction sees uncommitted changes", async () => {
    await client.$transaction(async (tx) => {
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
    const result = await client.$transaction(async (tx) => {
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
    await client.$transaction(async (tx) => {
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
      await client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "error-1", name: "Error User 1", email: "error@test.com" },
        });
        await tx.user.create({
          data: { id: "error-2", name: "Error User 2", email: "error2@test.com" },
        });
        // Violate unique constraint
        await tx.user.create({
          data: { id: "error-3", name: "Error User 3", email: "error@test.com" },
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
      data: { id: "existing-batch", name: "Existing", email: "existingbatch@test.com" },
    });

    try {
      await client.$transaction([
        client.user.create({
          data: { id: "batch-new-1", name: "New 1", email: "batchnew1@test.com" },
        }),
        client.user.create({
          data: { id: "batch-new-2", name: "New 2", email: "existingbatch@test.com" }, // Conflict
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
      await client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "thrown-1", name: "Thrown User", email: "thrown@test.com" },
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
      await client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "async-err-1", name: "Async Error User", email: "asyncerr@test.com" },
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
      client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "preserve-1", name: "Preserve", email: "preserve@test.com" },
        });
        throw new Error(errorMessage);
      })
    ).rejects.toThrow(errorMessage);
  });

  test("transaction returns value on success", async () => {
    const result = await client.$transaction(async (tx) => {
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
    await client.$transaction(async (tx) => {
      await tx.user.create({
        data: { id: "commit-1", name: "Committed User", email: "commit@test.com" },
      });
    });

    // After transaction completes, changes should be visible
    const user = await client.user.findUnique({ where: { id: "commit-1" } });
    expect(user).not.toBeNull();
    expect(user?.name).toBe("Committed User");
  });

  test("changes are not visible after rollback", async () => {
    try {
      await client.$transaction(async (tx) => {
        await tx.user.create({
          data: { id: "rollback-1", name: "Rolled Back User", email: "rollback@test.com" },
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

    await client.$transaction(async (tx) => {
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
      data: { id: "read-update-1", name: "Original", email: "readupdate@test.com" },
    });

    await client.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: "read-update-1" } });
      expect(user?.name).toBe("Original");

      await tx.user.update({
        where: { id: "read-update-1" },
        data: { name: "Modified" },
      });

      const updated = await tx.user.findUnique({ where: { id: "read-update-1" } });
      expect(updated?.name).toBe("Modified");
    });

    const final = await client.user.findUnique({ where: { id: "read-update-1" } });
    expect(final?.name).toBe("Modified");
  });
});
