import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UniqueConstraintError } from "@errors";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { upsertAtomicitySchema as schema } from "@tests/fixtures/upsert-atomicity-schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

const UPDATED_NAME_PATTERN = /^updated-/;

type UpsertAtomicityClientConfig = VibORMConfig<typeof schema>;

type UpsertAtomicityClient = VibORMClient<UpsertAtomicityClientConfig>;

export interface UpsertAtomicityBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runUpsertAtomicityBehavior({
  driverName,
  createDriver,
}: UpsertAtomicityBehaviorOptions) {
  describe(`${driverName} upsert atomicity behavior`, () => {
    let client: UpsertAtomicityClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      client = createClient({
        schema,
        driver,
      });
      // Persistent databases (pg/mysql) keep tables between runs, and
      // re-pushing a schema with unique fields is not idempotent on
      // Postgres — always start from a clean slate.
      for (const table of [
        "upsert_atomicity_posts",
        "upsert_atomicity_users",
        "upsert_atomicity_tags",
        "upsert_atomicity_counters",
      ]) {
        await driver._executeRaw(`DROP TABLE IF EXISTS ${table}`);
      }
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("plain upsert creates the row when missing", async () => {
      const currentClient = requireClient(client);

      const created = await currentClient.tag.upsert({
        where: { name: "alpha" },
        create: { id: "tag-alpha", name: "alpha", count: 1 },
        update: { count: 99 },
      });

      expect(created.id).toBe("tag-alpha");
      expect(created.count).toBe(1);

      const rows = await currentClient.tag.findMany();
      expect(rows).toHaveLength(1);
    });

    test("plain upsert updates the row when present", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-beta", name: "beta", count: 1 },
      });

      const updated = await currentClient.tag.upsert({
        where: { name: "beta" },
        create: { id: "tag-other", name: "beta", count: 5 },
        update: { count: 42 },
      });

      expect(updated.id).toBe("tag-beta");
      expect(updated.count).toBe(42);

      const rows = await currentClient.tag.findMany();
      expect(rows).toHaveLength(1);
    });

    test("does not take the update branch for a conflict outside the requested target", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "occupied-id", name: "existing-name", count: 1 },
      });

      await expect(
        currentClient.tag.upsert({
          where: { name: "requested-target" },
          create: {
            id: "occupied-id",
            name: "requested-target",
            count: 2,
          },
          update: { count: 99 },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      const existing = await currentClient.tag.findUnique({
        where: { id: "occupied-id" },
      });
      const requestedTarget = await currentClient.tag.findUnique({
        where: { name: "requested-target" },
      });
      expect({ existing, requestedTarget }).toMatchObject({
        existing: { name: "existing-name", count: 1 },
        requestedTarget: null,
      });
    });

    test("unique upsert targets distinguish case, accents, and trailing spaces", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.createMany({
        data: [
          { id: "case-original", name: "Case", count: 1 },
          { id: "accent-original", name: "résumé", count: 1 },
          { id: "trailing-original", name: "trail", count: 1 },
        ],
      });

      const cases = [
        { id: "case-variant", name: "CASE" },
        { id: "accent-variant", name: "resume" },
        { id: "trailing-variant", name: "trail " },
      ];
      for (const variant of cases) {
        const created = await currentClient.tag.upsert({
          where: { name: variant.name },
          create: { ...variant, count: 2 },
          update: { count: 99 },
        });
        expect(created).toMatchObject({ ...variant, count: 2 });
      }

      const rows = await currentClient.tag.findMany();
      expect(rows).toHaveLength(6);
      expect(
        rows
          .filter((row) => row.id.endsWith("-original"))
          .map((row) => row.count)
      ).toEqual([1, 1, 1]);
    });

    test("plain upsert returns the row when the update is a no-op", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-noop", name: "noop", count: 7 },
      });

      // MySQL reports 0 affected rows when an UPDATE is a no-op.
      // leaves the row unchanged; the result must still be the row.
      const result = await currentClient.tag.upsert({
        where: { name: "noop" },
        create: { id: "tag-other", name: "noop", count: 1 },
        update: { count: 7 },
      });

      expect(result.id).toBe("tag-noop");
      expect(result.count).toBe(7);
    });

    test("plain upsert create branch resolves auto-increment ids", async () => {
      const currentClient = requireClient(client);

      const created = await currentClient.counter.upsert({
        where: { key: "hits" },
        create: { key: "hits", value: 1 },
        update: { value: 2 },
      });

      expect(typeof created.id).toBe("number");
      expect(created.value).toBe(1);

      const updated = await currentClient.counter.upsert({
        where: { key: "hits" },
        create: { key: "hits", value: 1 },
        update: { value: 2 },
      });

      expect(updated.id).toBe(created.id);
      expect(updated.value).toBe(2);
    });

    test("upsert update branch may rewrite the unique where field", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-rename", name: "old-name", count: 1 },
      });

      const renamed = await currentClient.tag.upsert({
        where: { name: "old-name" },
        create: { id: "tag-other", name: "old-name", count: 5 },
        update: { name: "new-name", count: 2 },
      });

      expect(renamed.id).toBe("tag-rename");
      expect(renamed.name).toBe("new-name");
      expect(renamed.count).toBe(2);

      const rows = await currentClient.tag.findMany();
      expect(rows).toHaveLength(1);
    });

    test("upsert supports select on both branches", async () => {
      const currentClient = requireClient(client);

      const created = await currentClient.tag.upsert({
        where: { name: "selected" },
        create: { id: "tag-selected", name: "selected", count: 3 },
        update: { count: 4 },
        select: { name: true, count: true },
      });
      expect(created).toEqual({ name: "selected", count: 3 });

      const updated = await currentClient.tag.upsert({
        where: { name: "selected" },
        create: { id: "tag-selected", name: "selected", count: 3 },
        update: { count: 4 },
        select: { name: true, count: true },
      });
      expect(updated).toEqual({ name: "selected", count: 4 });
    });

    test("upsert with include returns the relation payload on both branches", async () => {
      const currentClient = requireClient(client);

      // Create branch: the nested create runs through the transaction
      // fallback; the returned payload must include the created relation.
      const created = await currentClient.user.upsert({
        where: { id: "include-user" },
        create: {
          id: "include-user",
          name: "created",
          posts: { create: { id: "include-post", title: "Included" } },
        },
        update: { name: "updated" },
        include: { posts: true },
      });

      expect(created.id).toBe("include-user");
      expect(created.name).toBe("created");
      expect(created.posts).toHaveLength(1);
      expect(created.posts[0]).toMatchObject({
        id: "include-post",
        title: "Included",
        userId: "include-user",
      });

      // Update branch: the create payload is ignored; the include must
      // reflect the already-persisted relation rows.
      const updated = await currentClient.user.upsert({
        where: { id: "include-user" },
        create: {
          id: "include-user",
          name: "never",
          posts: { create: { id: "include-post-unused", title: "Never" } },
        },
        update: { name: "updated" },
        include: { posts: true },
      });

      expect(updated.id).toBe("include-user");
      expect(updated.name).toBe("updated");
      expect(updated.posts).toHaveLength(1);
      expect(updated.posts[0]).toMatchObject({
        id: "include-post",
        title: "Included",
        userId: "include-user",
      });

      const posts = await currentClient.post.findMany();
      expect(posts).toHaveLength(1);
    });

    test("delete with include returns the relation payload", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "delete-include-user",
          name: "Author",
          posts: { create: { id: "delete-include-post", title: "Doomed" } },
        },
      });

      const deleted = await currentClient.post.delete({
        where: { id: "delete-include-post" },
        include: { author: true },
      });

      expect(deleted).toMatchObject({
        id: "delete-include-post",
        title: "Doomed",
        userId: "delete-include-user",
      });
      expect(deleted.author).toMatchObject({
        id: "delete-include-user",
        name: "Author",
      });

      const [posts, author] = await Promise.all([
        currentClient.post.findMany(),
        currentClient.user.findUnique({
          where: { id: "delete-include-user" },
        }),
      ]);
      expect(posts).toHaveLength(0);
      expect(author?.name).toBe("Author");
    });

    test("concurrent plain upserts of the same missing key both succeed", async () => {
      const currentClient = requireClient(client);

      const results = await Promise.all([
        currentClient.tag.upsert({
          where: { name: "plain-race" },
          create: { id: "plain-race-1", name: "plain-race", count: 1 },
          update: { count: 10 },
        }),
        currentClient.tag.upsert({
          where: { name: "plain-race" },
          create: { id: "plain-race-2", name: "plain-race", count: 2 },
          update: { count: 20 },
        }),
      ]);

      expect(results).toHaveLength(2);

      const rows = await currentClient.tag.findMany({
        where: { name: "plain-race" },
      });
      expect(rows).toHaveLength(1);
      // One upsert created, the other took the update branch.
      expect([10, 20]).toContain(rows[0]?.count);
    });

    test("concurrent fallback upserts of the same missing key both succeed", async () => {
      const currentClient = requireClient(client);

      // The nested create forces the SELECT-then-write transaction fallback
      // on every adapter, which is where the create-branch race lives.
      const upsertUser = (n: number) =>
        currentClient.user.upsert({
          where: { id: "race-user" },
          create: {
            id: "race-user",
            name: `created-${n}`,
            posts: { create: { id: `race-post-${n}`, title: `title-${n}` } },
          },
          update: { name: `updated-${n}` },
        });

      const results = await Promise.all([upsertUser(1), upsertUser(2)]);
      expect(results).toHaveLength(2);

      const users = await currentClient.user.findMany({
        where: { id: "race-user" },
      });
      expect(users).toHaveLength(1);
      // Exactly one upsert created; the other must have taken the
      // update branch (never a second create, never a raw constraint error).
      expect(users[0]?.name).toMatch(UPDATED_NAME_PATTERN);

      const posts = await currentClient.post.findMany();
      expect(posts).toHaveLength(1);
    });
  });
}

function requireClient(
  client: UpsertAtomicityClient | undefined
): UpsertAtomicityClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}

export const upsertAtomicityContract = defineContract({
  id: "drivers.upsert-atomicity",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runUpsertAtomicityBehavior,
});
