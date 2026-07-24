import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { compoundKeyBehaviorSchema as schema } from "../fixtures/compound-key-behavior-schema";

type CompoundKeyClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type CompoundKeyClient = VibORMClient<CompoundKeyClientConfig>;

export interface CompoundKeyBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runCompoundKeyBehavior({
  driverName,
  createDriver,
}: CompoundKeyBehaviorOptions) {
  describe(`${driverName} compound key behavior`, () => {
    let client: CompoundKeyClient | undefined;

    beforeEach(async () => {
      client = createClient({
        schema,
        driver: createDriver(),
      });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("push enforces the compound primary key", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: { tenantId: "t1", id: "a1", name: "Alice" },
      });
      // Same id under another tenant is a different compound key
      await currentClient.author.create({
        data: { tenantId: "t2", id: "a1", name: "Alicia" },
      });

      await expect(
        currentClient.author.create({
          data: { tenantId: "t1", id: "a1", name: "Duplicate" },
        })
      ).rejects.toThrow();
    });

    test("push enforces the compound unique constraint", async () => {
      const currentClient = requireClient(client);
      await currentClient.account.create({
        data: { id: "acc-1", provider: "github", providerId: "u1" },
      });
      await currentClient.account.create({
        data: { id: "acc-2", provider: "github", providerId: "u2" },
      });

      await expect(
        currentClient.account.create({
          data: { id: "acc-3", provider: "github", providerId: "u1" },
        })
      ).rejects.toThrow();
    });

    test("findUnique resolves compound id and compound unique selectors", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: { tenantId: "t1", id: "a1", name: "Alice" },
      });
      await currentClient.account.create({
        data: { id: "acc-1", provider: "github", providerId: "u1" },
      });

      const author = await currentClient.author.findUnique({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
      });
      expect(author?.name).toBe("Alice");

      const account = await currentClient.account.findUnique({
        where: {
          provider_providerId: { provider: "github", providerId: "u1" },
        },
      });
      expect(account?.id).toBe("acc-1");
    });

    test("nested create from a compound-id parent populates all FK columns", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: {
          tenantId: "t1",
          id: "a1",
          name: "Alice",
          posts: {
            create: { id: "p1", title: "Hello" },
          },
        },
      });

      const post = await currentClient.post.findUnique({ where: { id: "p1" } });
      expect(post?.tenantId).toBe("t1");
      expect(post?.authorId).toBe("a1");
    });

    test("connect from a compound-id parent populates all FK columns", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: { tenantId: "t1", id: "a1", name: "Alice" },
      });
      await currentClient.post.create({
        data: { id: "p1", title: "Orphan", tenantId: null, authorId: null },
      });

      await currentClient.author.update({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { posts: { connect: { id: "p1" } } },
      });

      const post = await currentClient.post.findUnique({ where: { id: "p1" } });
      expect(post?.tenantId).toBe("t1");
      expect(post?.authorId).toBe("a1");
    });

    test("include correlates on every compound FK column, not just one", async () => {
      const currentClient = requireClient(client);
      // Two authors sharing the same id across tenants: correlating on a
      // single column would leak the other tenant's posts.
      await currentClient.author.create({
        data: {
          tenantId: "t1",
          id: "a1",
          name: "Alice",
          posts: { create: { id: "p1", title: "T1 post" } },
        },
      });
      await currentClient.author.create({
        data: {
          tenantId: "t2",
          id: "a1",
          name: "Alicia",
          posts: { create: { id: "p2", title: "T2 post" } },
        },
      });

      const author = await currentClient.author.findUnique({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        include: { posts: true },
      });
      expect(author?.posts.map((post) => post.id)).toEqual(["p1"]);
    });

    test("is null treats a partially-null compound FK as no relation", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: { tenantId: "t1", id: "a1", name: "Alice" },
      });
      await currentClient.post.create({
        data: {
          id: "p-full",
          title: "Full FK",
          tenantId: "t1",
          authorId: "a1",
        },
      });
      await currentClient.post.create({
        data: {
          id: "p-partial",
          title: "Partial FK",
          tenantId: "t1",
          authorId: null,
        },
      });
      await currentClient.post.create({
        data: { id: "p-none", title: "No FK", tenantId: null, authorId: null },
      });

      const orphans = await currentClient.post.findMany({
        where: { author: { is: null } },
        orderBy: { id: "asc" },
      });
      expect(orphans.map((post) => post.id)).toEqual(["p-none", "p-partial"]);

      const attached = await currentClient.post.findMany({
        where: { author: { isNot: null } },
      });
      expect(attached.map((post) => post.id)).toEqual(["p-full"]);
    });

    test("update and delete by compound id target only that row", async () => {
      const currentClient = requireClient(client);
      await currentClient.author.create({
        data: { tenantId: "t1", id: "a1", name: "Alice" },
      });
      await currentClient.author.create({
        data: { tenantId: "t2", id: "a1", name: "Alicia" },
      });

      await currentClient.author.update({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        data: { name: "Alice Updated" },
      });
      const untouched = await currentClient.author.findUnique({
        where: { tenantId_id: { tenantId: "t2", id: "a1" } },
      });
      expect(untouched?.name).toBe("Alicia");

      await currentClient.author.delete({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
      });
      const remaining = await currentClient.author.findMany({});
      expect(remaining.map((author) => author.tenantId)).toEqual(["t2"]);
    });

    test("upsert on a compound-id model takes both branches", async () => {
      const currentClient = requireClient(client);

      await currentClient.author.upsert({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      });
      let author = await currentClient.author.findUnique({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
      });
      expect(author?.name).toBe("Created");

      await currentClient.author.upsert({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
        create: { tenantId: "t1", id: "a1", name: "Created" },
        update: { name: "Updated" },
      });
      author = await currentClient.author.findUnique({
        where: { tenantId_id: { tenantId: "t1", id: "a1" } },
      });
      expect(author?.name).toBe("Updated");
    });
  });
}

function requireClient(
  client: CompoundKeyClient | undefined
): CompoundKeyClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}
