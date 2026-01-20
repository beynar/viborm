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
});

const post = s.model({
  id: s.string().id(),
  title: s.string(),
  authorId: s.string(),
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
    expect(users[0].name).toBe("Alice");
  });

  test("PendingOperation has execute() method", async () => {
    await client.user.create({
      data: { id: "1", name: "Bob", email: "bob@test.com" },
    });

    const operation = client.user.findMany();
    const users = await operation.execute();
    expect(users).toHaveLength(1);
    expect(users[0].name).toBe("Bob");
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
