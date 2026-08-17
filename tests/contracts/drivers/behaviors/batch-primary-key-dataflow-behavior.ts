import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { sql } from "@sql";
import { defineContract } from "@tests/contracts/contract";
import { batchPrimaryKeyDataflowSchema as schema } from "@tests/fixtures/batch-primary-key-dataflow-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

type BatchPrimaryKeyDataflowConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type BatchPrimaryKeyDataflowClient =
  VibORMClient<BatchPrimaryKeyDataflowConfig>;

export interface BatchPrimaryKeyDataflowOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

const numericPkCases = [
  {
    label: "increment",
    startId: 300,
    update: { increment: 5 },
    expectedId: 305,
  },
  {
    label: "decrement",
    startId: 310,
    update: { decrement: 7 },
    expectedId: 303,
  },
  { label: "multiply", startId: 320, update: { multiply: 2 }, expectedId: 640 },
  { label: "divide", startId: 330, update: { divide: 3 }, expectedId: 110 },
] as const;

export function runBatchPrimaryKeyDataflowBehavior({
  driverName,
  createDriver,
}: BatchPrimaryKeyDataflowOptions) {
  describe(`${driverName} batch primary-key dataflow`, () => {
    let client: BatchPrimaryKeyDataflowClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      if (!driver.supportsBatch || driver.supportsTransactions) {
        await driver.disconnect();
        throw new Error(
          `${driverName} must be configured as a batch-only atomic driver for primary-key dataflow conformance.`
        );
      }

      client = createClient({ schema, driver });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("generated parent ID feeds to-many child FK", async () => {
      const currentClient = requireClient(client);

      const operation = currentClient.generatedUser.create({
        data: {
          name: "Generated parent",
          featuredChildId: null,
          posts: {
            create: { title: "Child", slug: "generated-parent-child" },
          },
        },
      });
      const created = await operation;

      const posts = await currentClient.generatedPost.findMany();
      expect(posts).toHaveLength(1);
      expect(posts[0]?.userId).toBe(created.id);
    });

    test("generated parent ID feeds nested createMany child FKs", async () => {
      const currentClient = requireClient(client);

      const operation = currentClient.generatedUser.create({
        data: {
          name: "Generated parent createMany",
          featuredChildId: null,
          posts: {
            createMany: {
              data: [
                { title: "First child", slug: "generated-create-many-1" },
                { title: "Second child", slug: "generated-create-many-2" },
              ],
            },
          },
        },
      });
      const created = await operation;

      const posts = await currentClient.generatedPost.findMany({
        orderBy: { slug: "asc" },
      });
      expect(posts).toHaveLength(2);
      expect(posts.map((post) => post.userId)).toEqual([
        created.id,
        created.id,
      ]);
    });

    test("generated child ID feeds to-one parent FK", async () => {
      const currentClient = requireClient(client);

      const operation = currentClient.generatedUser.create({
        data: {
          name: "Generated child",
          featuredChild: {
            create: { label: "Featured" },
          },
        },
      });
      const created = await operation;

      const featuredChild = await currentClient.featuredChild.findFirst();
      expect(featuredChild?.id).toBe(created.featuredChildId);
    });

    test("generated parent ID feeds multiple sibling relation branches", async () => {
      const currentClient = requireClient(client);

      const operation = currentClient.generatedUser.create({
        data: {
          name: "Sibling branches",
          featuredChildId: null,
          posts: {
            create: { title: "Post branch", slug: "sibling-post" },
          },
          notes: {
            create: { body: "Note branch" },
          },
        },
      });
      const created = await operation;

      const [posts, notes] = await Promise.all([
        currentClient.generatedPost.findMany(),
        currentClient.generatedNote.findMany(),
      ]);
      expect(posts[0]?.userId).toBe(created.id);
      expect(notes[0]?.userId).toBe(created.id);
    });

    test("generated parent, child, and grandchild IDs flow through recursive create", async () => {
      const currentClient = requireClient(client);

      const operation = currentClient.generatedUser.create({
        data: {
          name: "Deep generated",
          featuredChildId: null,
          posts: {
            create: {
              title: "Generated child",
              slug: "deep-generated-child",
              comments: {
                create: { body: "Generated grandchild" },
              },
            },
          },
        },
      });
      await operation;

      const [user, post, comment] = await Promise.all([
        currentClient.generatedUser.findFirst(),
        currentClient.generatedPost.findFirst(),
        currentClient.generatedComment.findFirst(),
      ]);
      expect(post?.userId).toBe(user?.id);
      expect(comment?.postId).toBe(post?.id);
    });

    test("top-level update changes PK with direct literal and nested create uses it", async () => {
      const currentClient = requireClient(client);
      await currentClient.mutableUser.create({
        data: { id: 100, name: "Direct literal" },
      });

      const updated = await currentClient.mutableUser.update({
        where: { id: 100 },
        data: {
          id: 101,
          name: "Direct literal updated",
          posts: { create: { title: "Direct literal child" } },
        },
      });

      const [oldUser, newUser, posts] = await Promise.all([
        currentClient.mutableUser.findUnique({ where: { id: 100 } }),
        currentClient.mutableUser.findUnique({ where: { id: 101 } }),
        currentClient.mutablePost.findMany(),
      ]);
      expect(updated.id).toBe(101);
      expect(oldUser).toBeNull();
      expect(newUser?.name).toBe("Direct literal updated");
      expect(posts[0]?.userId).toBe(101);
    });

    test("top-level update changes PK with set operation and nested create uses it", async () => {
      const currentClient = requireClient(client);
      await currentClient.mutableUser.create({
        data: { id: 200, name: "Set operation" },
      });

      const updated = await currentClient.mutableUser.update({
        where: { id: 200 },
        data: {
          id: { set: 201 },
          name: "Set operation updated",
          posts: { create: { title: "Set operation child" } },
        },
      });

      const posts = await currentClient.mutablePost.findMany();
      expect(updated.id).toBe(201);
      expect(posts[0]?.userId).toBe(201);
    });

    for (const numericCase of numericPkCases) {
      test(`top-level update changes numeric PK with ${numericCase.label} and nested create uses it`, async () => {
        const currentClient = requireClient(client);
        await currentClient.mutableUser.create({
          data: {
            id: numericCase.startId,
            name: `${numericCase.label} operation`,
          },
        });

        const updated = await currentClient.mutableUser.update({
          where: { id: numericCase.startId },
          data: {
            id: numericCase.update,
            name: `${numericCase.label} operation updated`,
            posts: {
              create: { title: `${numericCase.label} operation child` },
            },
          },
        });

        const posts = await currentClient.mutablePost.findMany();
        expect(updated.id).toBe(numericCase.expectedId);
        expect(posts[0]?.userId).toBe(numericCase.expectedId);
      });
    }

    test("top-level upsert update branch changes PK before nested create", async () => {
      const currentClient = requireClient(client);
      await currentClient.mutableUser.create({
        data: { id: 700, name: "Upsert source" },
      });

      const updated = await currentClient.mutableUser.upsert({
        where: { id: 700 },
        create: { id: 701, name: "Unused create" },
        update: {
          id: 702,
          name: "Upsert updated",
          posts: { create: { title: "Upsert child" } },
        },
      });

      const posts = await currentClient.mutablePost.findMany();
      expect(updated.id).toBe(702);
      expect(posts[0]?.userId).toBe(702);
    });

    test("failure after generated refs rolls back parent and children", async () => {
      const currentClient = requireClient(client);

      await expect(
        currentClient.generatedUser.create({
          data: {
            id: -1,
            name: "Rollback generated refs",
            featuredChildId: null,
            posts: {
              create: [
                { title: "First", slug: "duplicate-generated-slug" },
                { title: "Second", slug: "duplicate-generated-slug" },
              ],
            },
          },
        })
      ).rejects.toThrow();

      const [users, posts] = await Promise.all([
        currentClient.generatedUser.findMany(),
        currentClient.generatedPost.findMany(),
      ]);
      expect(users).toHaveLength(0);
      expect(posts).toHaveLength(0);
    });

    test("unsupported compound primary-key dataflow rejects before parent mutation", async () => {
      const currentClient = requireClient(client);
      const missingCompoundPart = {
        orgId: "org-1",
        name: "Missing compound part",
      };

      await expect(
        currentClient.compoundOwner.create({
          // @ts-expect-error Missing compound PK part is intentional fail-closed coverage.
          data: missingCompoundPart,
        })
      ).rejects.toThrow();

      const owners = await currentClient.compoundOwner.findMany();
      expect(owners).toHaveLength(0);
    });

    test("unsafe PK update shape rejects before parent mutation", async () => {
      const currentClient = requireClient(client);
      await currentClient.mutableUser.create({
        data: { id: 900, name: "Unsafe source" },
      });

      const unsafePkUpdate = {
        id: sql`"id" + 1`,
        name: "Unsafe updated",
        posts: { create: { title: "Should not create" } },
      };

      await expect(
        currentClient.mutableUser.update({
          where: { id: 900 },
          // @ts-expect-error Raw SQL PK update is intentional fail-closed coverage.
          data: unsafePkUpdate,
        })
      ).rejects.toThrow();

      const [user, posts] = await Promise.all([
        currentClient.mutableUser.findUnique({ where: { id: 900 } }),
        currentClient.mutablePost.findMany(),
      ]);
      expect(user?.name).toBe("Unsafe source");
      expect(posts).toHaveLength(0);
    });
  });
}

function requireClient(
  client: BatchPrimaryKeyDataflowClient | undefined
): BatchPrimaryKeyDataflowClient {
  if (!client) {
    throw new Error(
      "Batch primary-key dataflow test client was not initialized."
    );
  }
  return client;
}

export const batchPrimaryKeyDataflowContract = defineContract({
  id: "drivers.batch-primary-key-dataflow",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runBatchPrimaryKeyDataflowBehavior,
});
