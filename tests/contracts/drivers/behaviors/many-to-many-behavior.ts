import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { defineContract } from "@tests/contracts/contract";
import { manyToManySchema as schema } from "@tests/fixtures/many-to-many-schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

type ManyToManyClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};

type ManyToManyClient = VibORMClient<ManyToManyClientConfig>;

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

    async function labelNamesOf(articleId: number): Promise<string[]> {
      const article = await requireClient(client).article.findUnique({
        where: { id: articleId },
        include: { labels: true },
      });
      return (article?.labels ?? [])
        .map((label: { name: string }) => label.name)
        .sort();
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
            connectOrCreate: {
              where: { id: "t1" },
              create: { id: "t1", name: "ignored" },
            },
          },
        },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1"]);
      const t1 = await c.tag.findUnique({ where: { id: "t1" } });
      expect(t1?.name).toBe("tag-1");

      // The planner cannot inspect custom/existing column collations, so two
      // string selectors are not certified disjoint inside one planned
      // operation. Exercise the missing branch separately.
      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connectOrCreate: {
              where: { id: "t9" },
              create: { id: "t9", name: "tag-9" },
            },
          },
        },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1", "t9"]);
      const t9 = await c.tag.findUnique({ where: { id: "t9" } });
      expect(t9?.name).toBe("tag-9");
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

    // RETARGETED by N6-U3 (own-write linearization, ATOM §4.1), from a rejection to an
    // accept-and-execute assertion on the SAME payload, on every driver leg. `connect`
    // reads nothing, so it is a stage-3 pure adder ordered AFTER the junction's
    // `deleteMany`, whose filter is therefore resolved against committed membership —
    // t2 is not a member when the removal runs, so tag-2 survives and the sibling
    // `connect` then attaches it. The rejection this replaced was the legality
    // derivation walking an order the engine did not execute.
    test("connect lands after a deleteMany that cannot see it", async () => {
      const c = requireClient(client);
      await c.post.update({
        where: { id: "p1" },
        data: { tags: { connect: { id: "t1" } } },
      });

      await c.post.update({
        where: { id: "p1" },
        data: {
          tags: {
            connect: { id: "t2" },
            deleteMany: { name: "tag-2" },
          },
        },
      });

      expect(await tagIdsOf("p1")).toEqual(["t1", "t2"]);
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

    // ------------------------------------------------------------------
    // DB-generated (auto-increment) primary keys on BOTH junction sides —
    // the regression class the string-PK fixtures above missed: the child
    // INSERT *produces* the identity the join row references (RETURNING on
    // returning tx drivers, driver insertId elsewhere; scratch-threaded in
    // batch mode), and the fresh parent's own produced id feeds the join.
    // ------------------------------------------------------------------

    test("create through the junction with a DB-generated target primary key", async () => {
      const c = requireClient(client);

      // Pre-existing target: the same create also CONNECTs it, so the join rows
      // reference both a produced target id and the fresh parent's produced id.
      const connected = await c.label.create({
        data: { id: -1, name: "gen-pre" },
      });
      const operation = c.article.create({
        data: {
          title: "Article 1",
          labels: {
            create: [{ name: "gen-a" }, { name: "gen-b" }],
            connect: { id: connected.id },
          },
        },
      });
      const created = await operation;

      const article = await c.article.findUnique({
        where: { id: created.id },
        include: { labels: true },
      });
      expect(
        (article?.labels ?? [])
          .map((label: { name: string }) => label.name)
          .sort()
      ).toEqual(["gen-a", "gen-b", "gen-pre"]);
      // Each created label carries a real generated identity.
      const ids = (article?.labels ?? []).map(
        (label: { id: number }) => label.id
      );
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) {
        expect(typeof id).toBe("number");
      }
    });

    test("junction create with a generated target PK under an update root", async () => {
      const c = requireClient(client);

      const created = await c.article.create({
        data: { id: 1, title: "Article 2" },
      });
      const operation = c.article.update({
        where: { id: created.id },
        data: { labels: { create: { name: "gen-upd" } } },
      });
      await operation;

      const article = await c.article.findUnique({
        where: { id: created.id },
        include: { labels: true },
      });
      expect(
        (article?.labels ?? []).map((label: { name: string }) => label.name)
      ).toEqual(["gen-upd"]);
      const label = await c.label.findUnique({ where: { name: "gen-upd" } });
      expect(typeof label?.id).toBe("number");
    });

    test("connectOrCreate with a generated target PK connects existing and creates missing", async () => {
      const c = requireClient(client);

      const existing = await c.label.create({
        data: { id: -1, name: "gen-existing" },
      });
      const created = await c.article.create({
        data: { id: 1, title: "Article 3" },
      });

      await c.article.update({
        where: { id: created.id },
        data: {
          labels: {
            connectOrCreate: {
              where: { name: "gen-existing" },
              create: { name: "gen-existing" },
            },
          },
        },
      });
      expect(await labelNamesOf(created.id)).toEqual(["gen-existing"]);

      const missingOperation = c.article.update({
        where: { id: created.id },
        data: {
          labels: {
            connectOrCreate: {
              where: { name: "gen-missing" },
              create: { name: "gen-missing" },
            },
          },
        },
      });
      await missingOperation;

      const article = await c.article.findUnique({
        where: { id: created.id },
        include: { labels: true },
      });
      expect(
        (article?.labels ?? [])
          .map((label: { name: string }) => label.name)
          .sort()
      ).toEqual(["gen-existing", "gen-missing"]);
      // The found arm adopted the pre-existing row, not a re-created one.
      const adopted = (article?.labels ?? []).find(
        (label: { name: string }) => label.name === "gen-existing"
      );
      expect(adopted?.id).toBe(existing.id);
      expect(await c.label.count()).toBe(2);
    });

    // RETARGETED by N3-U2, from a decline to an accept-and-execute assertion on the
    // SAME payload. This test used to pin `upsert-through-junction … requires the
    // target primary key in the create data`: the create arm's dedup ledger and its
    // duplicate-item UPDATE addressed the target by a compile-time literal, so a
    // DB-generated identity was refused. W4's create-data-unique identity source
    // closed it — and N7-U-C then deleted the ledger outright (every reachable firing
    // of its duplicate branch applied an item's update to a row that item's `where`
    // never named), taking the last consumer of the arm's compile-time `where` with it.
    // The join row rides the produced identity `Ref` the create / connectOrCreate arms
    // already use, which is all it ever needed; there is no surviving identity refusal
    // on this arm. See `junction-create-many-behavior.ts`, on every driver leg and both
    // substrates.
    test("upsert through the junction creates a target whose PK the database generates", async () => {
      const c = requireClient(client);
      const created = await c.article.create({
        data: { id: 1, title: "Article 4" },
      });
      // A decoy label the operation must not touch: the join row has to carry the id
      // this INSERT produced, not "some label".
      const decoy = await c.label.create({
        data: { id: -1, name: "gen-decoy" },
      });

      const operation = c.article.update({
        where: { id: created.id },
        data: {
          labels: {
            upsert: {
              where: { name: "gen-up" },
              create: { name: "gen-up" },
              update: { name: "gen-up2" },
            },
          },
        },
      });
      await operation;

      const article = await c.article.findUnique({
        where: { id: created.id },
        include: { labels: true },
      });
      const linked = article?.labels ?? [];
      expect(linked.map((label: { name: string }) => label.name)).toEqual([
        "gen-up",
      ]);
      // The created row's id is the one the join row names, and it is NOT the decoy's.
      const fresh = await c.label.findUnique({ where: { name: "gen-up" } });
      expect(linked[0]?.id).toBe(fresh?.id);
      expect(linked[0]?.id).not.toBe(decoy.id);
    });
  });
}

function requireClient(client: ManyToManyClient | undefined): ManyToManyClient {
  if (!client) {
    throw new Error("Client not initialized");
  }
  return client;
}

export const manyToManyContract = defineContract({
  id: "drivers.many-to-many",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runManyToManyBehavior,
});
