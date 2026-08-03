import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { nestedWriteBehaviorSchema as schema } from "../fixtures/nested-write-behavior-schema";

type NestedWriteClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type NestedWriteClient = VibORMClient<NestedWriteClientConfig>;

export interface NestedWriteBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runNestedWriteBehavior({
  driverName,
  createDriver,
}: NestedWriteBehaviorOptions) {
  describe(`${driverName} nested write behavior`, () => {
    let client: NestedWriteClient | undefined;

    beforeEach(async () => {
      const driver = createDriver();
      if (!(driver.supportsTransactions || driver.supportsBatch)) {
        await driver.disconnect();
        throw new Error(
          `${driverName} cannot be included in nested-write conformance without an atomic nested-write strategy.`
        );
      }

      client = createClient({
        schema,
        driver,
      });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    test("declares an atomic strategy for nested writes", () => {
      const driver = requireClient(client).$driver;
      expect(driver.supportsTransactions || driver.supportsBatch).toBe(true);
    });

    test("rejects default-only createMany duplicate skipping before writing", async () => {
      const currentClient = requireClient(client);

      await expect(
        currentClient.defaultOnlyRecord.createMany({
          data: [{}, {}],
          skipDuplicates: true,
        })
      ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");

      expect(await currentClient.defaultOnlyRecord.count()).toBe(0);
    });

    test("rejects nested default-only duplicate skipping before the parent write", async () => {
      const currentClient = requireClient(client);

      await expect(
        currentClient.defaultOnlyParent.create({
          data: {
            id: "default-only-parent",
            children: {
              createMany: {
                data: [{}],
                skipDuplicates: true,
              },
            },
          },
        })
      ).rejects.toThrow("no portable duplicate-only DEFAULT VALUES primitive");

      expect(await currentClient.defaultOnlyParent.count()).toBe(0);
      expect(await currentClient.defaultOnlyChild.count()).toBe(0);
    });

    test("create derives to-one and to-many foreign keys", async () => {
      const currentClient = requireClient(client);

      await currentClient.user.create({
        data: {
          id: "user-create",
          name: "Alice",
          profile: {
            create: {
              id: "profile-create",
              bio: "Alice bio",
            },
          },
          posts: {
            createMany: {
              data: [
                { id: "post-create-1", title: "First" },
                { id: "post-create-2", title: "Second" },
              ],
            },
          },
        },
      });

      const [profile, posts] = await Promise.all([
        currentClient.profile.findUnique({ where: { id: "profile-create" } }),
        currentClient.post.findMany({ orderBy: { id: "asc" } }),
      ]);

      expect(profile?.userId).toBe("user-create");
      expect(posts.map((post) => post.userId)).toEqual([
        "user-create",
        "user-create",
      ]);
    });

    test("create connects and connect-or-creates nullable children", async () => {
      const currentClient = requireClient(client);
      await currentClient.post.create({
        data: { id: "post-connect", title: "Existing", userId: null },
      });
      await currentClient.post.create({
        data: { id: "post-coc-existing", title: "Already here", userId: null },
      });

      await currentClient.user.create({
        data: {
          id: "user-connect",
          name: "Bob",
          posts: {
            connect: { id: "post-connect" },
            connectOrCreate: {
              where: { id: "post-coc-existing" },
              create: { id: "post-coc-existing", title: "Ignored" },
            },
          },
        },
      });

      const connectedPosts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(connectedPosts.map((post) => post.id)).toEqual([
        "post-coc-existing",
        "post-connect",
      ]);
      expect(connectedPosts.map((post) => post.userId)).toEqual([
        "user-connect",
        "user-connect",
      ]);

      // The planner cannot inspect custom/existing column collations, so it
      // conservatively keeps distinct string decisions in separate operations.
      await currentClient.user.update({
        where: { id: "user-connect" },
        data: {
          posts: {
            connectOrCreate: {
              where: { id: "post-coc-created" },
              create: { id: "post-coc-created", title: "Created" },
            },
          },
        },
      });

      const postsAfterCreate = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(postsAfterCreate.map((post) => post.id)).toEqual([
        "post-coc-created",
        "post-coc-existing",
        "post-connect",
      ]);
      expect(postsAfterCreate.map((post) => post.userId)).toEqual([
        "user-connect",
        "user-connect",
        "user-connect",
      ]);
      expect(postsAfterCreate.map((post) => post.title)).toEqual([
        "Created",
        "Already here",
        "Existing",
      ]);
    });

    test("update creates, createManys, and connects children", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: { id: "user-update-create", name: "Cara" },
      });
      await currentClient.post.create({
        data: { id: "post-existing", title: "Existing", userId: null },
      });

      await currentClient.user.update({
        where: { id: "user-update-create" },
        data: {
          posts: {
            create: { id: "post-created", title: "Created" },
            createMany: {
              data: [
                { id: "post-created-many-1", title: "Many 1" },
                { id: "post-created-many-2", title: "Many 2" },
              ],
            },
            connect: { id: "post-existing" },
          },
        },
      });

      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.userId)).toEqual([
        "user-update-create",
        "user-update-create",
        "user-update-create",
        "user-update-create",
      ]);
    });

    test("update disconnects and sets nullable children", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-set-source",
          name: "Dora",
          posts: {
            create: [
              { id: "post-disconnect", title: "Disconnect" },
              { id: "post-replaced", title: "Replace" },
            ],
          },
        },
      });
      await currentClient.user.create({
        data: {
          id: "user-set-target",
          name: "Evan",
          posts: {
            create: { id: "post-set-target", title: "Set target" },
          },
        },
      });

      await currentClient.user.update({
        where: { id: "user-set-source" },
        data: {
          posts: {
            disconnect: { id: "post-disconnect" },
          },
        },
      });
      await currentClient.user.update({
        where: { id: "user-set-source" },
        data: {
          posts: {
            set: { id: "post-set-target" },
          },
        },
      });

      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.userId)).toEqual([
        null,
        null,
        "user-set-source",
      ]);
    });

    test("update and updateMany keep child mutations parent-correlated", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-update-owner",
          name: "Faye",
          posts: {
            create: [
              { id: "post-update-one", title: "Draft" },
              { id: "post-update-many", title: "Queued" },
            ],
          },
        },
      });
      await currentClient.user.create({
        data: {
          id: "user-update-other",
          name: "Gus",
          posts: {
            create: { id: "post-other", title: "Queued" },
          },
        },
      });

      await currentClient.user.update({
        where: { id: "user-update-owner" },
        data: {
          posts: {
            update: {
              where: { id: "post-update-one" },
              data: { title: "Updated one" },
            },
            updateMany: {
              where: { title: "Queued" },
              data: { title: "Updated many" },
            },
          },
        },
      });

      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.title)).toEqual([
        "Queued",
        "Updated many",
        "Updated one",
      ]);
    });

    test("delete and deleteMany keep child mutations parent-correlated", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-delete-owner",
          name: "Hana",
          posts: {
            create: [
              { id: "post-delete-one", title: "Remove one" },
              { id: "post-delete-many", title: "Remove many" },
            ],
          },
        },
      });
      await currentClient.user.create({
        data: {
          id: "user-delete-other",
          name: "Ivan",
          posts: {
            create: { id: "post-delete-other", title: "Remove many" },
          },
        },
      });

      await currentClient.user.update({
        where: { id: "user-delete-owner" },
        data: {
          posts: {
            delete: { id: "post-delete-one" },
            deleteMany: { title: "Remove many" },
          },
        },
      });

      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.id)).toEqual(["post-delete-other"]);
      expect(posts[0]?.userId).toBe("user-delete-other");
    });

    test("to-many upsert creates and updates the current parent's child", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: { id: "user-upsert-many", name: "Jules" },
      });

      await currentClient.user.update({
        where: { id: "user-upsert-many" },
        data: {
          posts: {
            upsert: {
              where: { id: "post-upsert-many" },
              create: { id: "post-upsert-many", title: "Created" },
              update: { title: "Unused" },
            },
          },
        },
      });
      await currentClient.user.update({
        where: { id: "user-upsert-many" },
        data: {
          posts: {
            upsert: {
              where: { id: "post-upsert-many" },
              create: { id: "post-upsert-unused", title: "Should not create" },
              update: { title: "Updated" },
            },
          },
        },
      });

      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.id)).toEqual(["post-upsert-many"]);
      expect(posts[0]?.title).toBe("Updated");
      expect(posts[0]?.userId).toBe("user-upsert-many");
    });

    test("to-one upsert creates and updates the current target", async () => {
      const currentClient = requireClient(client);
      await currentClient.post.create({
        data: { id: "post-upsert-one", title: "Orphan", userId: null },
      });

      await currentClient.post.update({
        where: { id: "post-upsert-one" },
        data: {
          author: {
            upsert: {
              create: { id: "user-upsert-one", name: "Created" },
              update: { name: "Unused" },
            },
          },
        },
      });
      await currentClient.post.update({
        where: { id: "post-upsert-one" },
        data: {
          author: {
            upsert: {
              create: { id: "user-upsert-unused", name: "Should not create" },
              update: { name: "Updated" },
            },
          },
        },
      });

      const [post, users] = await Promise.all([
        currentClient.post.findUnique({ where: { id: "post-upsert-one" } }),
        currentClient.user.findMany({ orderBy: { id: "asc" } }),
      ]);
      expect(post?.userId).toBe("user-upsert-one");
      expect(users.map((user) => user.id)).toEqual(["user-upsert-one"]);
      expect(users[0]?.name).toBe("Updated");
    });

    test("to-one nested update modifies the connected author", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-toone-update",
          name: "Before",
          posts: { create: { id: "post-toone-update", title: "Post" } },
        },
      });

      const updated = await currentClient.post.update({
        where: { id: "post-toone-update" },
        data: { author: { update: { name: "After" } } },
      });
      expect(updated.id).toBe("post-toone-update");
      expect(updated.title).toBe("Post");
      expect(updated.userId).toBe("user-toone-update");

      const users = await currentClient.user.findMany();
      expect(users.map((user) => [user.id, user.name])).toEqual([
        ["user-toone-update", "After"],
      ]);
    });

    test("to-one disconnect true nulls the foreign key, both rows survive", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-toone-disconnect",
          name: "Owner",
          posts: { create: { id: "post-toone-disconnect", title: "Linked" } },
        },
      });

      const updated = await currentClient.post.update({
        where: { id: "post-toone-disconnect" },
        data: { author: { disconnect: true } },
      });
      expect(updated.id).toBe("post-toone-disconnect");
      expect(updated.userId).toBeNull();

      const [user, post] = await Promise.all([
        currentClient.user.findUnique({
          where: { id: "user-toone-disconnect" },
        }),
        currentClient.post.findUnique({
          where: { id: "post-toone-disconnect" },
        }),
      ]);
      expect(user?.name).toBe("Owner");
      expect(post?.title).toBe("Linked");
      expect(post?.userId).toBeNull();
    });

    test("to-one delete true deletes the related row", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-toone-delete",
          name: "Keeper",
          profile: { create: { id: "profile-toone-delete", bio: "doomed" } },
        },
      });

      const updated = await currentClient.user.update({
        where: { id: "user-toone-delete" },
        data: { profile: { delete: true } },
      });
      expect(updated.id).toBe("user-toone-delete");
      expect(updated.name).toBe("Keeper");

      const [user, profiles] = await Promise.all([
        currentClient.user.findUnique({ where: { id: "user-toone-delete" } }),
        currentClient.profile.findMany(),
      ]);
      expect(user?.name).toBe("Keeper");
      expect(profiles).toHaveLength(0);
    });

    // Family A (TO-ONE.md §7.2), absorbed in T3a: the FK-holder-side (parent-held)
    // to-one `delete: true` — NULL the post's own FK, then delete the referenced
    // author. A second post held by a different author is the witness: it must
    // survive with its FK intact.
    test("to-one delete true (FK-holder side) nulls the FK then deletes the author", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-ph-delete",
          name: "Doomed",
          posts: { create: { id: "post-ph-delete", title: "Holder" } },
        },
      });
      // Witness: a second author whose post must be untouched.
      await currentClient.user.create({
        data: {
          id: "user-ph-witness",
          name: "Witness",
          posts: { create: { id: "post-ph-witness", title: "Other" } },
        },
      });

      const updated = await currentClient.post.update({
        where: { id: "post-ph-delete" },
        data: { author: { delete: true } },
      });
      expect(updated.id).toBe("post-ph-delete");
      expect(updated.userId).toBeNull();

      const users = await currentClient.user.findMany({
        orderBy: { id: "asc" },
      });
      expect(users.map((user) => user.id)).toEqual(["user-ph-witness"]);
      const posts = await currentClient.post.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-ph-delete", null],
        ["post-ph-witness", "user-ph-witness"],
      ]);
    });

    // Family F (TO-ONE.md §7.2), absorbed in T3-r2: the inverse-side (child-held)
    // to-one `upsert` — a correlated locate (WHERE fk = parent, no unique `where`).
    // Runs V2's native correlated-upsert SQL on every driver here (5-DB matrix). The
    // second user's profile is the correlation witness: neither arm may touch it.
    test("inverse-side to-one upsert: absent creates, found updates, witness survives", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: { id: "u-upsert-inv", name: "a" },
      });
      await currentClient.user.create({
        data: { id: "u-upsert-wit", name: "b" },
      });
      await currentClient.profile.create({
        data: { id: "pr-witness", bio: "witness", userId: "u-upsert-wit" },
      });

      // Absent arm: u-upsert-inv has no profile → create it with fk = parent.
      await currentClient.user.update({
        where: { id: "u-upsert-inv" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-inv", bio: "created" },
              update: { bio: "unused" },
            },
          },
        },
      });
      // Found arm: now it has one → update it (create arm ignored).
      await currentClient.user.update({
        where: { id: "u-upsert-inv" },
        data: {
          profile: {
            upsert: {
              create: { id: "pr-nope", bio: "nope" },
              update: { bio: "updated" },
            },
          },
        },
      });

      const profiles = await currentClient.profile.findMany({
        orderBy: { id: "asc" },
      });
      expect(profiles).toEqual([
        { id: "pr-inv", bio: "updated", userId: "u-upsert-inv" },
        { id: "pr-witness", bio: "witness", userId: "u-upsert-wit" },
      ]);
    });

    test("explicit join rows work as a practical many-to-many case", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-red", name: "red" },
      });
      await currentClient.tag.create({
        data: { id: "tag-blue", name: "blue" },
      });

      await currentClient.post.create({
        data: {
          id: "post-tagged",
          title: "Tagged",
          userId: null,
          postTags: {
            create: [
              {
                id: "join-blue",
                tag: { connect: { id: "tag-blue" } },
              },
              {
                id: "join-red",
                tag: { connect: { id: "tag-red" } },
              },
            ],
          },
        },
      });

      const joins = await currentClient.postTag.findMany({
        orderBy: { id: "asc" },
      });
      expect(joins.map((join) => join.postId)).toEqual([
        "post-tagged",
        "post-tagged",
      ]);
      expect(joins.map((join) => join.tagId)).toEqual(["tag-blue", "tag-red"]);
    });

    test("unsupported nested create keys reject before parent mutation", async () => {
      const currentClient = requireClient(client);

      await expect(
        currentClient.user.create({
          data: {
            id: "user-invalid-key",
            name: "Invalid",
            posts: {
              // @ts-expect-error create inputs must reject update-only nested keys.
              deleteMany: { title: "Nope" },
            },
          },
        })
      ).rejects.toThrow("Unknown key: deleteMany");

      const users = await currentClient.user.findMany();
      expect(users).toHaveLength(0);
    });

    test("nested child failures roll back parent and prior children", async () => {
      const currentClient = requireClient(client);

      await expect(
        currentClient.user.create({
          data: {
            id: "user-rollback-create",
            name: "Kate",
            posts: {
              createMany: {
                data: [
                  { id: "post-rollback", title: "First" },
                  { id: "post-rollback", title: "Duplicate" },
                ],
              },
            },
          },
        })
      ).rejects.toThrow();

      const [users, posts] = await Promise.all([
        currentClient.user.findMany(),
        currentClient.post.findMany(),
      ]);
      expect(users).toHaveLength(0);
      expect(posts).toHaveLength(0);
    });

    test("to-many updates cannot target another parent's child", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-correlation-owner",
          name: "Lina",
          posts: {
            create: { id: "post-correlation-owner", title: "Owner" },
          },
        },
      });
      await currentClient.user.create({
        data: {
          id: "user-correlation-other",
          name: "Milo",
          posts: {
            create: { id: "post-correlation-other", title: "Other" },
          },
        },
      });

      const updateOtherParentChild = currentClient.user.update({
        where: { id: "user-correlation-owner" },
        data: {
          name: "Changed",
          posts: {
            update: {
              where: { id: "post-correlation-other" },
              data: { title: "Stolen" },
            },
          },
        },
      });
      // Both substrates now surface the SAME typed correlated-not-found message
      // (§7 error unification). This FK update tree is interpreted since M5, so
      // planned mode's correlated `update` probe throws the typed error at plan
      // time (§3.4 required probe) instead of the old generic assertion abort —
      // the M7 message-unification landing for M5-eligible FK trees (§7.3).
      await expect(updateOtherParentChild).rejects.toThrow(
        "Cannot update relation 'posts'"
      );

      const [user, otherPost] = await Promise.all([
        currentClient.user.findUnique({
          where: { id: "user-correlation-owner" },
        }),
        currentClient.post.findUnique({
          where: { id: "post-correlation-other" },
        }),
      ]);
      expect(user?.name).toBe("Lina");
      expect(otherPost?.title).toBe("Other");
      expect(otherPost?.userId).toBe("user-correlation-other");
    });

    test("non-nullable child foreign keys reject disconnect atomically", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-required", name: "required" },
      });
      await currentClient.post.create({
        data: {
          id: "post-required",
          title: "Required join",
          userId: null,
          postTags: {
            create: {
              id: "join-required",
              tag: { connect: { id: "tag-required" } },
            },
          },
        },
      });

      await expect(
        currentClient.post.update({
          where: { id: "post-required" },
          data: {
            title: "Changed",
            postTags: {
              disconnect: { id: "join-required" },
            },
          },
        })
      ).rejects.toThrow("foreign key field(s) postId are required");

      const [post, join] = await Promise.all([
        currentClient.post.findUnique({ where: { id: "post-required" } }),
        currentClient.postTag.findUnique({ where: { id: "join-required" } }),
      ]);
      expect(post?.title).toBe("Required join");
      expect(join?.postId).toBe("post-required");
      expect(join?.tagId).toBe("tag-required");
    });

    test("nested create propagates foreign keys through mapped columns", async () => {
      const currentClient = requireClient(client);

      const created = await currentClient.mappedUser.create({
        data: {
          id: "mapped-user-create",
          name: "Mapped",
          posts: {
            create: { id: "mapped-post-create", title: "Mapped child" },
          },
        },
      });

      // The mutation result must expose field names, not raw column names.
      expect(created.id).toBe("mapped-user-create");
      expect(created.name).toBe("Mapped");
      expect(created).not.toHaveProperty("uid");
      expect(created).not.toHaveProperty("full_name");

      const post = await currentClient.mappedPost.findUnique({
        where: { id: "mapped-post-create" },
      });
      expect(post?.authorId).toBe("mapped-user-create");
    });

    test("nested create derives mapped foreign keys for createMany and connect", async () => {
      const currentClient = requireClient(client);
      await currentClient.mappedPost.create({
        data: {
          id: "mapped-post-existing",
          title: "Existing",
          authorId: null,
        },
      });

      await currentClient.mappedUser.create({
        data: {
          id: "mapped-user-many",
          name: "Mapped Many",
          posts: {
            createMany: {
              data: [
                { id: "mapped-post-many-1", title: "First" },
                { id: "mapped-post-many-2", title: "Second" },
              ],
            },
            connect: { id: "mapped-post-existing" },
          },
        },
      });

      const posts = await currentClient.mappedPost.findMany({
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => post.authorId)).toEqual([
        "mapped-user-many",
        "mapped-user-many",
        "mapped-user-many",
      ]);
    });

    test("set keeping all required-FK children is a no-op and succeeds", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-set-noop", name: "set-noop" },
      });
      await currentClient.post.create({
        data: {
          id: "post-set-noop",
          title: "Set no-op",
          userId: null,
          postTags: {
            create: {
              id: "join-set-noop",
              tag: { connect: { id: "tag-set-noop" } },
            },
          },
        },
      });

      // The only child is kept by the set, so nothing is orphaned.
      await currentClient.post.update({
        where: { id: "post-set-noop" },
        data: {
          postTags: { set: [{ id: "join-set-noop" }] },
        },
      });

      const join = await currentClient.postTag.findUnique({
        where: { id: "join-set-noop" },
      });
      expect(join?.postId).toBe("post-set-noop");

      // An empty set is also a no-op when the parent has no children.
      await currentClient.post.create({
        data: { id: "post-set-childless", title: "Childless", userId: null },
      });
      await currentClient.post.update({
        where: { id: "post-set-childless" },
        data: { postTags: { set: [] } },
      });
    });

    test("set on required-FK children rejects only when rows would be orphaned", async () => {
      const currentClient = requireClient(client);
      await currentClient.tag.create({
        data: { id: "tag-set-keep", name: "set-keep" },
      });
      await currentClient.tag.create({
        data: { id: "tag-set-orphan", name: "set-orphan" },
      });
      await currentClient.post.create({
        data: {
          id: "post-set-orphan",
          title: "Set orphan",
          userId: null,
          postTags: {
            create: [
              {
                id: "join-set-keep",
                tag: { connect: { id: "tag-set-keep" } },
              },
              {
                id: "join-set-orphan",
                tag: { connect: { id: "tag-set-orphan" } },
              },
            ],
          },
        },
      });

      const orphaningSet = currentClient.post.update({
        where: { id: "post-set-orphan" },
        data: {
          title: "Changed",
          postTags: { set: [{ id: "join-set-keep" }] },
        },
      });
      // Both substrates now surface the SAME typed orphan message (§7 error
      // unification, M7). This FK update tree is interpreted since M5; planned
      // mode's departing-rows `notExists` assertion aborts the batch and the
      // abort-attribution ladder (§7.3) maps it back to the orphan
      // GuardFailure's message — no longer the generic NestedWriteAssertionError.
      await expect(orphaningSet).rejects.toThrow(
        "Cannot set relation 'postTags' because foreign key field(s) postId are required"
      );

      const [post, keptJoin, orphanJoin] = await Promise.all([
        currentClient.post.findUnique({ where: { id: "post-set-orphan" } }),
        currentClient.postTag.findUnique({ where: { id: "join-set-keep" } }),
        currentClient.postTag.findUnique({ where: { id: "join-set-orphan" } }),
      ]);
      expect(post?.title).toBe("Set orphan");
      expect(keptJoin?.postId).toBe("post-set-orphan");
      expect(orphanJoin?.postId).toBe("post-set-orphan");
    });

    test("set disconnects only nullable-FK children leaving the set", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-set-partial",
          name: "Nia",
          posts: {
            create: [
              { id: "post-set-kept", title: "Kept" },
              { id: "post-set-dropped", title: "Dropped" },
            ],
          },
        },
      });
      await currentClient.post.create({
        data: { id: "post-set-added", title: "Added", userId: null },
      });

      await currentClient.user.update({
        where: { id: "user-set-partial" },
        data: {
          posts: {
            set: [{ id: "post-set-kept" }, { id: "post-set-added" }],
          },
        },
      });

      const posts = await currentClient.post.findMany({
        where: { id: { startsWith: "post-set-" } },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-set-added", "user-set-partial"],
        ["post-set-dropped", null],
        ["post-set-kept", "user-set-partial"],
      ]);
    });

    /**
     * PHASE 4 — the link IN-list fold (query-performance-plan). A `connect` /
     * `disconnect` list of one key shape sends ONE probe and ONE write for the
     * whole list instead of a pair per target. The statement count and the
     * grouping rule are witnessed on PGlite in
     * `tests/query-engine-v2/link-in-list-fold.test.ts`; what belongs here, on
     * every driver, is the SQL the fold newly emits — an `IN` list inside a
     * locked read and inside a bulk UPDATE — and that the missing-target
     * rejection still fails closed. MySQL matters most: it is non-returning, so
     * the folded write goes out as a plain `UPDATE … WHERE key IN (…)` with no
     * RETURNING clause to confirm it.
     */
    test("connect with a list of targets reparents every one of them", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({ data: { id: "user-in", name: "Ida" } });
      for (const id of ["post-in-1", "post-in-2", "post-in-3"]) {
        await currentClient.post.create({ data: { id, title: id } });
      }

      await currentClient.user.update({
        where: { id: "user-in" },
        data: {
          posts: {
            connect: [
              { id: "post-in-1" },
              { id: "post-in-2" },
              // Repeated on purpose: the fold's missing-target verdict counts
              // DISTINCT keys, so one row must satisfy both entries.
              { id: "post-in-2" },
              { id: "post-in-3" },
            ],
          },
        },
      });

      const posts = await currentClient.post.findMany({
        where: { id: { startsWith: "post-in-" } },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-in-1", "user-in"],
        ["post-in-2", "user-in"],
        ["post-in-3", "user-in"],
      ]);
    });

    test("a connect list with one absent target writes nothing", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: { id: "user-in-miss", name: "Ivo" },
      });
      await currentClient.post.create({
        data: { id: "post-in-present", title: "Present" },
      });

      await expect(
        currentClient.user.update({
          where: { id: "user-in-miss" },
          data: {
            posts: {
              connect: [{ id: "post-in-present" }, { id: "post-in-absent" }],
            },
          },
        })
      ).rejects.toThrow(
        "Cannot connect relation 'posts': target record was not found."
      );

      const present = await currentClient.post.findUnique({
        where: { id: "post-in-present" },
      });
      expect(present?.userId).toBeNull();
    });

    test("disconnect with a list nulls every one of them", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-in-drop",
          name: "Ines",
          posts: {
            create: [
              { id: "post-in-drop-1", title: "One" },
              { id: "post-in-drop-2", title: "Two" },
            ],
          },
        },
      });

      await currentClient.user.update({
        where: { id: "user-in-drop" },
        data: {
          posts: {
            disconnect: [{ id: "post-in-drop-1" }, { id: "post-in-drop-2" }],
          },
        },
      });

      const posts = await currentClient.post.findMany({
        where: { id: { startsWith: "post-in-drop-" } },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-in-drop-1", null],
        ["post-in-drop-2", null],
      ]);
    });

    test("a disconnect list naming ANOTHER parent's child nulls nothing", async () => {
      const currentClient = requireClient(client);
      await currentClient.user.create({
        data: {
          id: "user-in-mine",
          name: "Iris",
          posts: { create: [{ id: "post-in-mine", title: "Mine" }] },
        },
      });
      await currentClient.user.create({
        data: {
          id: "user-in-theirs",
          name: "Ivan",
          posts: { create: [{ id: "post-in-theirs", title: "Theirs" }] },
        },
      });

      // The grouped probe's correlation half is the only thing that tells a
      // connected-elsewhere row apart from a legitimate disconnect.
      await expect(
        currentClient.user.update({
          where: { id: "user-in-mine" },
          data: {
            posts: {
              disconnect: [{ id: "post-in-mine" }, { id: "post-in-theirs" }],
            },
          },
        })
      ).rejects.toThrow(
        "Cannot disconnect relation 'posts': target record was not found for this parent."
      );

      const posts = await currentClient.post.findMany({
        where: { id: { startsWith: "post-in-" } },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-in-mine", "user-in-mine"],
        ["post-in-theirs", "user-in-theirs"],
      ]);
    });

    test("a create tree's connect list reparents every one of them", async () => {
      const currentClient = requireClient(client);
      for (const id of ["post-in-new-1", "post-in-new-2"]) {
        await currentClient.post.create({ data: { id, title: id } });
      }

      await currentClient.user.create({
        data: {
          id: "user-in-new",
          name: "Iona",
          posts: {
            connect: [{ id: "post-in-new-1" }, { id: "post-in-new-2" }],
          },
        },
      });

      const posts = await currentClient.post.findMany({
        where: { id: { startsWith: "post-in-new-" } },
        orderBy: { id: "asc" },
      });
      expect(posts.map((post) => [post.id, post.userId])).toEqual([
        ["post-in-new-1", "user-in-new"],
        ["post-in-new-2", "user-in-new"],
      ]);
    });
  });
}

function requireClient(
  client: NestedWriteClient | undefined
): NestedWriteClient {
  if (!client) {
    throw new Error("Nested write behavior test client was not initialized.");
  }
  return client;
}
