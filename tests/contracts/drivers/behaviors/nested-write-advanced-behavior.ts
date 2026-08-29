import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nestedWriteBehaviorSchema as schema } from "@tests/fixtures/nested-write-behavior-schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

type NestedWriteClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type NestedWriteClient = VibORMClient<NestedWriteClientConfig>;

export interface NestedWriteAdvancedBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runNestedWriteAdvancedBehavior({
  driverName,
  createDriver,
}: NestedWriteAdvancedBehaviorOptions) {
  describe(`${driverName} advanced nested write behavior`, () => {
    let client: NestedWriteClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      if (!(driver.supportsTransactions || driver.supportsBatch)) {
        await driver.disconnect();
        throw new Error(
          `${driverName} cannot run nested-write conformance without an atomic strategy.`
        );
      }

      client = createClient({ schema, driver });
      await syncLiveSchema(client);
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("connectOrCreate create branch accepts recursive nested writes", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: { id: "user-coc-recursive", name: "Recursive" },
      });
      await currentClient.tag.create({
        data: { id: "tag-recursive", name: "recursive" },
      });

      await currentClient.user.update({
        where: { id: "user-coc-recursive" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: "post-coc-recursive" },
              create: {
                id: "post-coc-recursive",
                title: "Recursive child",
                postTags: {
                  create: {
                    id: "join-coc-recursive",
                    tag: { connect: { id: "tag-recursive" } },
                  },
                },
              },
            },
          },
        },
      });

      const [post, join] = await Promise.all([
        currentClient.post.findUnique({ where: { id: "post-coc-recursive" } }),
        currentClient.postTag.findUnique({
          where: { id: "join-coc-recursive" },
        }),
      ]);
      expect(post?.userId).toBe("user-coc-recursive");
      expect(join?.postId).toBe("post-coc-recursive");
      expect(join?.tagId).toBe("tag-recursive");
    });

    test("top-level upsert guards gate nested update branch", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-upsert-guard",
          name: "Alice",
          posts: {
            create: { id: "post-upsert-guard", title: "Draft" },
          },
        },
      });

      await currentClient.user.upsert({
        where: { id: "user-upsert-guard" },
        targetWhere: { name: "Bob" },
        create: { id: "user-unused-target", name: "Unused" },
        update: {
          name: "Wrong target",
          posts: {
            update: {
              where: { id: "post-upsert-guard" },
              data: { title: "Wrong target" },
            },
          },
        },
      });

      await currentClient.user.upsert({
        where: { id: "user-upsert-guard" },
        setWhere: { name: "Bob" },
        create: { id: "user-unused-set", name: "Unused" },
        update: {
          name: "Wrong set",
          posts: {
            update: {
              where: { id: "post-upsert-guard" },
              data: { title: "Wrong set" },
            },
          },
        },
      });

      const [skippedUser, skippedPost] = await Promise.all([
        currentClient.user.findUnique({ where: { id: "user-upsert-guard" } }),
        currentClient.post.findUnique({ where: { id: "post-upsert-guard" } }),
      ]);
      expect(skippedUser?.name).toBe("Alice");
      expect(skippedPost?.title).toBe("Draft");

      await currentClient.user.upsert({
        where: { id: "user-upsert-guard" },
        targetWhere: { name: "Alice" },
        setWhere: { name: "Alice" },
        create: { id: "user-unused-match", name: "Unused" },
        update: {
          name: "Updated",
          posts: {
            update: {
              where: { id: "post-upsert-guard" },
              data: { title: "Published" },
            },
          },
        },
      });

      const [user, post] = await Promise.all([
        currentClient.user.findUnique({ where: { id: "user-upsert-guard" } }),
        currentClient.post.findUnique({ where: { id: "post-upsert-guard" } }),
      ]);
      expect(user?.name).toBe("Updated");
      expect(post?.title).toBe("Published");
    });
  });
}

function requireClient(
  client: NestedWriteClient | undefined
): NestedWriteClient {
  if (!client) {
    throw new Error("Nested write test client was not initialized.");
  }
  return client;
}

export const nestedWriteAdvancedContract = defineContract({
  id: "drivers.nested-write-advanced",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runNestedWriteAdvancedBehavior,
});
