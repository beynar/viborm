/**
 * Mutation cache invalidation through `$transaction([...])`.
 *
 * A batch-only driver (D1, Neon HTTP — `supportsTransactions === false`,
 * `supportsBatch === true`) takes the client's SHARED-BATCH branch, which
 * prepares every operation and parses the driver's batch results. It never
 * calls `execute()`, so the `wrapExecutor` closure that carries mutation cache
 * invalidation (query-engine/cache-flow.ts) does not fire on that path — the
 * branch has to run the same invalidation itself, after the commit.
 *
 * On D1 the callback form of `$transaction` throws, so `$transaction([...])` is
 * the ONLY atomic multi-write API there: a cached read after a batched write
 * served stale rows forever, silently. These tests pin the batch branch against
 * the transaction branch, which is the reference behavior.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
  })
  .map("cache_batch_invalidation_user");

const schema = { user };

/**
 * The batch-only shape of PGlite: no interactive transactions, an atomic batch
 * instead. The base sequential `executeBatch` would run without a transaction,
 * so the override wraps the statements in one real transaction — the atomicity
 * D1's `batch()` provides.
 */
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

type Mode = "batch" | "transaction";

async function boot(mode: Mode) {
  const db = new PGlite();
  const setupClient = createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
  });
  await push(setupClient, { force: true });

  const cache = new MemoryCache();
  const client = createClient({
    schema,
    driver:
      mode === "batch"
        ? new BatchOnlyPGliteDriver({ client: db })
        : new PGliteDriver({ client: db }),
    cache,
  });
  await client.user.create({
    data: { id: "1", name: "Alice", email: "alice@test.com" },
  });
  return { cache, client };
}

const MODES: Mode[] = ["batch", "transaction"];

describe("$transaction([...]) mutation cache invalidation", () => {
  for (const mode of MODES) {
    test(`${mode}: a batched autoInvalidate write clears the model's cached reads`, async () => {
      const { client } = await boot(mode);

      const warm = await client
        .$withCache({ key: "user:all" })
        .user.findMany({ orderBy: { id: "asc" } });
      expect(warm).toHaveLength(1);

      await client.$transaction([
        client.user.create({
          data: { id: "2", name: "Bob", email: "bob@test.com" },
          cache: { autoInvalidate: true },
        }),
      ]);

      const after = await client
        .$withCache({ key: "user:all" })
        .user.findMany({ orderBy: { id: "asc" } });
      expect(after).toHaveLength(2);

      await client.$disconnect();
    });

    test(`${mode}: a batched write honors its own invalidate keys and no others`, async () => {
      const { client } = await boot(mode);

      await client.$withCache({ key: "user:all" }).user.findMany();
      await client.$withCache({ key: "user:count" }).user.count();

      await client.$transaction([
        client.user.create({
          data: { id: "2", name: "Bob", email: "bob@test.com" },
          cache: { invalidate: ["user:all"] },
        }),
      ]);

      // The named key was cleared and re-read against the committed batch…
      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(2);
      // …and the key the caller did NOT name is still the warm one.
      expect(await client.$withCache({ key: "user:count" }).user.count()).toBe(
        1
      );

      await client.$disconnect();
    });

    test(`${mode}: a batched write with no cache options invalidates nothing`, async () => {
      const { client } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);

      await client.$transaction([
        client.user.create({
          data: { id: "2", name: "Bob", email: "bob@test.com" },
        }),
      ]);

      // `autoInvalidate` defaults to false: the entry stays warm, exactly as on
      // the direct-await path.
      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);
      expect(await client.user.findMany()).toHaveLength(2);

      await client.$disconnect();
    });

    test(`${mode}: every mutation in a mixed batch invalidates, reads do not`, async () => {
      const { client } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);

      const [count, , updated] = await client.$transaction([
        client.user.count(),
        client.user.create({
          data: { id: "2", name: "Bob", email: "bob@test.com" },
          cache: { autoInvalidate: true },
        }),
        client.user.updateMany({
          where: { id: "1" },
          data: { name: "Alice II" },
          cache: { autoInvalidate: true },
        }),
      ]);
      expect(count).toBe(1);
      expect(updated).toEqual({ count: 1 });

      const after = await client
        .$withCache({ key: "user:all" })
        .user.findMany({ orderBy: { id: "asc" } });
      expect(after).toHaveLength(2);
      expect(after[0]?.name).toBe("Alice II");

      await client.$disconnect();
    });

    test(`${mode}: a rolled-back batch leaves the cache alone`, async () => {
      const { client } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);

      await expect(
        client.$transaction([
          client.user.create({
            data: { id: "2", name: "Bob", email: "bob@test.com" },
            cache: { autoInvalidate: true },
          }),
          // Same unique email: the batch aborts and rolls back.
          client.user.create({
            data: { id: "3", name: "Bob again", email: "bob@test.com" },
            cache: { autoInvalidate: true },
          }),
        ])
      ).rejects.toThrow();

      // Nothing committed, so the warm entry is still TRUE — and the database
      // agrees with it.
      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);
      expect(await client.user.findMany()).toHaveLength(1);

      await client.$disconnect();
    });
  }
});
