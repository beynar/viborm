import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
/**
 * Mutation cache invalidation through `$transaction([...])`.
 *
 * A batch-only driver (D1, Neon HTTP — `supportsTransactions === false`,
 * `supportsBatch === true`) takes the client's SHARED-BATCH branch, which
 * prepares every operation and parses the driver's batch results. It stages the
 * same package-owned write outcome registrations before dispatch, then publishes
 * them only after the batch commit.
 *
 * On D1 the callback form of `$transaction` throws, so `$transaction([...])` is
 * the ONLY atomic multi-write API there: a cached read after a batched write
 * served stale rows forever, silently. These tests pin the batch branch against
 * the transaction branch, which is the reference behavior.
 */

import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";

import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique(),
  })
  .map("cache_batch_invalidation_user");

const schema = { user };

type Mode = "batch" | "transaction";

async function boot(mode: Mode) {
  const db = new PGlite();
  const setupClient = createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
  });
  await syncLiveSchema(setupClient);

  const cache = new MemoryCache();
  const background: Promise<unknown>[] = [];
  const client = createClient({
    schema,
    driver:
      mode === "batch"
        ? new BatchOnlyPGliteDriver({ client: db })
        : new PGliteDriver({ client: db }),
  }).$extends(
    cacheExtension({
      driver: cache,
      waitUntil: (promise) => background.push(promise),
    })
  );
  await client.user.create({
    data: { id: "1", name: "Alice", email: "alice@test.com" },
  });
  return {
    client,
    settle: async () => {
      while (background.length > 0) {
        await Promise.all(background.splice(0));
      }
    },
  };
}

const MODES: Mode[] = ["batch", "transaction"];

describe("$transaction([...]) mutation cache invalidation", () => {
  for (const mode of MODES) {
    test(`${mode}: a batched autoInvalidate write clears the model's cached reads`, async () => {
      const { client, settle } = await boot(mode);

      const warm = await client
        .$withCache({ key: "user:all" })
        .user.findMany({ orderBy: { id: "asc" } });
      expect(warm).toHaveLength(1);
      await settle();

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
      const { client, settle } = await boot(mode);

      await client.$withCache({ key: "user:all" }).user.findMany();
      await client.$withCache({ key: "user:count" }).user.count();
      await settle();

      await client.$transaction([
        client.user.create({
          data: { id: "2", name: "Bob", email: "bob@test.com" },
          cache: { invalidate: ["user:findMany:*"] },
        }),
      ]);

      // The named operation prefix was cleared and re-read against the
      // committed batch…
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
      const { client, settle } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);
      await settle();

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
      const { client, settle } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);
      await settle();

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
      const { client, settle } = await boot(mode);

      expect(
        await client.$withCache({ key: "user:all" }).user.findMany()
      ).toHaveLength(1);
      await settle();

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
