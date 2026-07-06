import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { manyToManySchema as schema } from "../fixtures/many-to-many-schema";

type ManyToManyClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ManyToManyClient = VibORMClient<ManyToManyClientConfig>;

const DELETE_MANY_CONFLICT = /deleteMany/;
const NAME_DISAMBIGUATION = /\.name\(\)/;

export interface ManyToManyBehaviorOptions {
  driverName: string;
  createDriver: () => AnyDriver;
}

export function runManyToManyBehavior({
  driverName,
  createDriver,
}: ManyToManyBehaviorOptions) {
  describe(`${driverName} many-to-many write behavior`, () => {
    let client: ManyToManyClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await push(client, { force: true });

      const c = requireClient(client);
      await c.post.create({ data: { id: "p1", title: "Post 1" } });
      await c.post.create({ data: { id: "p2", title: "Post 2" } });
      await c.tag.create({
        data: { id: "t1", name: "tag-1", featuredPostId: null },
      });
      await c.tag.create({
        data: { id: "t2", name: "tag-2", featuredPostId: null },
      });
      await c.tag.create({
        data: { id: "t3", name: "tag-3", featuredPostId: null },
      });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    async function tagIdsOf(postId: string): Promise<string[]> {
      const post = await requireClient(client).post.findUnique({
        where: { id: postId },
        include: { tags: true },
      });
      return (post?.tags ?? []).map((tag: { id: string }) => tag.id).sort();
    }

    test("connect inserts junction rows without touching unrelated foreign keys", async () => {
      const c = requireClient(client);

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1", "t2"]);

      // Regression: tag.featuredIn (a to-one back at post) must stay untouched
      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.featuredPostId).toBeNull();
    });

    test("connect is idempotent", async () => {
      const c = requireClient(client);

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1"]);
    });

    test("connect of a missing record fails", async () => {
      const c = requireClient(client);

      await expect(
        c.post.update({
          where: { id: "p1" },
          data: { tags: { connect: { id: "missing" } } },
        })
      ).rejects.toThrow();

      expect(await tagIdsOf("p1")).toEqual([]);
    });

    test("create connects and creates through the junction on parent create", async () => {
      const c = requireClient(client);

      await c.post.create({
        data: {
          id: "p3",
          title: "Post 3",
          tags: {
            connect: { id: "t1" },
            create: { id: "t-new", name: "tag-new" },
          },
        },
      });

      expect(await tagIdsOf("p3")).toEqual(["t-new", "t1"]);
      const created = await c.tag.findUnique({ where: { id: "t-new" } });
      expect(created?.name).toBe("tag-new");
    });

    test("connectOrCreate connects existing and creates missing", async () => {
      const c = requireClient(client);

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: [
              { where: { id: "t1" }, create: { id: "t1", name: "ignored" } },
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9" } },
            ],
          },
        },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1", "t9"]);
      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.name).toBe("tag-1");
    });

    test("disconnect removes the association and keeps the row", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { disconnect: { id: "t1" } } },
      });

      expect(await tagIdsOf("p1")).toEqual(["t2"]);
      expect(await c.tag.findUnique({ where: { id: "t1" } })).not.toBeNull();
    });

    test("set replaces the association set", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { set: [{ id: "t2" }, { id: "t3" }] } },
      });
      expect(await tagIdsOf("p1")).toEqual(["t2", "t3"]);
      expect(await c.tag.findUnique({ where: { id: "t1" } })).not.toBeNull();

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { set: [] } },
      });
      expect(await tagIdsOf("p1")).toEqual([]);
    });

    test("delete removes the child row and all its associations", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });
      await c.post.update({
        where: { id: "p2" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: { tags: { delete: { id: "t1" } } },
      });

      expect(await c.tag.findUnique({ where: { id: "t1" } })).toBeNull();
      expect(await tagIdsOf("p1")).toEqual(["t2"]);
      // The shared association from the other parent is gone too
      expect(await tagIdsOf("p2")).toEqual([]);
    });

    test("delete of a record not connected to the parent fails", async () => {
      const c = requireClient(client);

      await expect(
        c.post.update({
          where: { id: "p1" },
          data: { tags: { delete: { id: "t1" } } },
        })
      ).rejects.toThrow();

      expect(await c.tag.findUnique({ where: { id: "t1" } })).not.toBeNull();
    });

    test("deleteMany deletes only connected rows matching the filter", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });

      // Matches t1 (connected) and t3 (not connected) by name prefix
      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: { deleteMany: { name: { in: ["tag-1", "tag-3"] } } },
        },
      });

      expect(await c.tag.findUnique({ where: { id: "t1" } })).toBeNull();
      expect(await c.tag.findUnique({ where: { id: "t3" } })).not.toBeNull();
      expect(await tagIdsOf("p1")).toEqual(["t2"]);
    });

    test("writes from the side without junction config resolve the same junction", async () => {
      const c = requireClient(client);

      // post.tags carries .through()/.A()/.B(); tag.posts is bare
      await c.tag.update({
        where: { id: "t1" },
        data: { posts: { connect: [{ id: "p1" }, { id: "p2" }] } },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1"]);
      expect(await tagIdsOf("p2")).toEqual(["t1"]);

      await c.tag.update({
        where: { id: "t1" },
        data: { posts: { disconnect: { id: "p1" } } },
      });
      expect(await tagIdsOf("p1")).toEqual([]);
      expect(await tagIdsOf("p2")).toEqual(["t1"]);
    });

    test("implicit default junction works end to end", async () => {
      const c = requireClient(client);
      await c.category.create({ data: { id: "c1", name: "cat-1" } });

      await c.post.update({
        where: { id: "p1" },
        data: { categories: { connect: { id: "c1" } } },
      });

      const category = await c.category.findUnique({
        where: { id: "c1" },
        include: { posts: true },
      });
      expect(
        (category?.posts ?? []).map((post: { id: string }) => post.id)
      ).toEqual(["p1"]);
    });

    test("rows participating in a many-to-many can be deleted directly", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      // Junction FKs default to ON DELETE CASCADE (Prisma parity), so this
      // must not throw ForeignKeyError.
      await c.post.delete({ where: { id: "p1" } });

      expect(await c.post.findUnique({ where: { id: "p1" } })).toBeNull();
      expect(await c.tag.findUnique({ where: { id: "t1" } })).not.toBeNull();
    });

    test("nested update modifies a connected record only", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            update: { where: { id: "t1" }, data: { name: "tag-1-renamed" } },
          },
        },
      });
      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.name).toBe("tag-1-renamed");

      // t2 exists but is not connected to p1
      await expect(
        c.post.update({
          where: { id: "p1" },
          data: {
            tags: {
              update: { where: { id: "t2" }, data: { name: "nope" } },
            },
          },
        })
      ).rejects.toThrow();
      const t2 = await c.tag.findUnique({ where: { id: "t2" } });
      expect(t2?.name).toBe("tag-2");
    });

    test("nested updateMany touches only connected rows matching the filter", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: [{ id: "t1" }, { id: "t2" }] } },
      });

      // Filter matches t1 (connected) and t3 (not connected)
      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            updateMany: {
              where: { name: { in: ["tag-1", "tag-3"] } },
              data: { featuredPostId: "p2" },
            },
          },
        },
      });

      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      const t2 = await c.tag.findUnique({ where: { id: "t2" } });
      const t3 = await c.tag.findUnique({ where: { id: "t3" } });
      expect(t1?.featuredPostId).toBe("p2");
      expect(t2?.featuredPostId).toBeNull();
      expect(t3?.featuredPostId).toBeNull();
    });

    test("nested upsert updates a connected record", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t1" },
              create: { id: "t1", name: "never" },
              update: { name: "tag-1-upserted" },
            },
          },
        },
      });

      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.name).toBe("tag-1-upserted");
      expect(await tagIdsOf("p1")).toEqual(["t1"]);
    });

    test("nested upsert creates and connects a missing record", async () => {
      const c = requireClient(client);

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            upsert: {
              where: { id: "t9" },
              create: { id: "t9", name: "tag-9" },
              update: { name: "never" },
            },
          },
        },
      });

      const t9 = await c.tag.findUnique({ where: { id: "t9" } });
      expect(t9?.name).toBe("tag-9");
      expect(await tagIdsOf("p1")).toEqual(["t9"]);
    });

    test("nested upsert of an existing but unconnected record fails", async () => {
      const c = requireClient(client);

      await expect(
        c.post.update({
          where: { id: "p1" },
          data: {
            tags: {
              upsert: {
                where: { id: "t1" },
                create: { id: "t1", name: "never" },
                update: { name: "never" },
              },
            },
          },
        })
      ).rejects.toThrow();

      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.name).toBe("tag-1");
      expect(await tagIdsOf("p1")).toEqual([]);
    });

    test("connect combined with deleteMany in one update is rejected", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await expect(
        c.post.update({
          where: { id: "p1" },
          data: {
            tags: {
              connect: { id: "t2" },
              deleteMany: { name: "tag-2" },
            },
          },
        })
      ).rejects.toThrow(DELETE_MANY_CONFLICT);

      expect(await tagIdsOf("p1")).toEqual(["t1"]);
      expect(await c.tag.findUnique({ where: { id: "t2" } })).not.toBeNull();
    });

    test("duplicate connectOrCreate targets collapse to one association", async () => {
      const c = requireClient(client);

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: [
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9" } },
              { where: { id: "t9" }, create: { id: "t9", name: "tag-9b" } },
            ],
          },
        },
      });

      expect(await tagIdsOf("p1")).toEqual(["t9"]);
      const t9 = await c.tag.findUnique({ where: { id: "t9" } });
      expect(t9?.name).toBe("tag-9");
    });

    test("boolean disconnect on a many-to-many relation is rejected", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await expect(
        c.post.update({
          where: { id: "p1" },
          data: {
            tags: { disconnect: true as unknown as { id: string } },
          },
        })
      ).rejects.toThrow();

      expect(await tagIdsOf("p1")).toEqual(["t1"]);
    });

    test("named duplicate pairs keep isolated junction tables", async () => {
      const c = requireClient(client);
      await c.alpha.create({ data: { id: "a1" } });
      await c.beta.create({ data: { id: "b1" } });

      await c.alpha.update({
        where: { id: "a1" },
        data: { likes: { connect: { id: "b1" } } },
      });

      const a1 = await c.alpha.findUnique({
        where: { id: "a1" },
        include: { likes: true, stars: true },
      });
      expect((a1?.likes ?? []).map((x: { id: string }) => x.id)).toEqual([
        "b1",
      ]);
      expect(a1?.stars ?? []).toEqual([]);

      const b1 = await c.beta.findUnique({
        where: { id: "b1" },
        include: { likedBy: true, starredBy: true },
      });
      expect((b1?.likedBy ?? []).map((x: { id: string }) => x.id)).toEqual([
        "a1",
      ]);
      expect(b1?.starredBy ?? []).toEqual([]);
    });

    test("unnamed duplicate pairs are rejected at push", async () => {
      const dupSchema = (() => {
        const gamma = s
          .model({
            id: s.string().id(),
            x: s.manyToMany(() => delta),
            y: s.manyToMany(() => delta),
          })
          .map("m2m_gammas");
        const delta = s
          .model({
            id: s.string().id(),
            xBy: s.manyToMany(() => gamma),
            yBy: s.manyToMany(() => gamma),
          })
          .map("m2m_deltas");
        return { gamma, delta };
      })();

      const dupClient = createClient({
        schema: dupSchema,
        driver: createDriver(),
      });
      try {
        await expect(push(dupClient, { force: true })).rejects.toThrow(
          NAME_DISAMBIGUATION
        );
      } finally {
        await dupClient.$disconnect();
      }
    });

    test("self-referential many-to-many round trip", async () => {
      const c = requireClient(client);
      await c.user.create({ data: { id: "u1", name: "Alice" } });
      await c.user.create({ data: { id: "u2", name: "Bob" } });
      await c.user.create({ data: { id: "u3", name: "Cara" } });

      await c.user.update({
        where: { id: "u1" },
        data: { follows: { connect: [{ id: "u2" }, { id: "u3" }] } },
      });

      const u1 = await c.user.findUnique({
        where: { id: "u1" },
        include: { follows: true },
      });
      expect(
        (u1?.follows ?? []).map((user: { id: string }) => user.id).sort()
      ).toEqual(["u2", "u3"]);

      // The inverse side traverses the junction in the opposite direction
      const u2 = await c.user.findUnique({
        where: { id: "u2" },
        include: { followedBy: true },
      });
      expect(
        (u2?.followedBy ?? []).map((user: { id: string }) => user.id)
      ).toEqual(["u1"]);

      await c.user.update({
        where: { id: "u1" },
        data: { follows: { disconnect: { id: "u2" } } },
      });
      const after = await c.user.findUnique({
        where: { id: "u1" },
        include: { follows: true },
      });
      expect(
        (after?.follows ?? []).map((user: { id: string }) => user.id)
      ).toEqual(["u3"]);
    });
  });
}

function requireClient(client: ManyToManyClient | undefined): ManyToManyClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}
