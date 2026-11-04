import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

/**
 * A junction that is a declared model, on a real database: its table, its own
 * column, its shared `organizationId`, and every way a relation write reaches
 * it. Fixtures are synthetic: organizations and teams with a parent graph.
 *
 * `child` and `parent` declare no inverse on `team`, which is the form the
 * resolver exempts; `throughWithInverses` below is the other legal form.
 */
export const throughSchema = () => {
  const teamParent = s
    .model({
      organizationId: s.string().map("organization_id"),
      childId: s.string().map("child_id"),
      parentId: s.string().map("parent_id"),
      createdAt: s.dateTime().now(),
      note: s.string().default("linked"),
      token: s.string().uuid({ generate: true }),
      remark: s.string().nullable(),
      child: s
        .toOne(() => team)
        .fields("organizationId", "childId")
        .references("organizationId", "id")
        .onDelete("cascade"),
      parent: s
        .toOne(() => team)
        .fields("organizationId", "parentId")
        .references("organizationId", "id")
        .onDelete("cascade"),
    })
    .id(["childId", "parentId"])
    .map("team_parent");
  const team = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      name: s.string().default("team"),
      parents: s
        .toMany(() => team)
        .name("teamGraph")
        .through(() => teamParent)
        .source("child")
        .target("parent"),
      children: s.toMany(() => team).name("teamGraph"),
    })
    .unique(["organizationId", "id"]);
  return { team, teamParent };
};

/** Each side's own inverse declared, so the links read as a relation too. */
const throughWithInverses = () => {
  const link = s
    .model({
      organizationId: s.string(),
      childId: s.string(),
      parentId: s.string(),
      child: s
        .toOne(() => node)
        .name("child")
        .fields("organizationId", "childId")
        .references("organizationId", "id")
        .onDelete("cascade"),
      parent: s
        .toOne(() => node)
        .name("parent")
        .fields("organizationId", "parentId")
        .references("organizationId", "id")
        .onDelete("cascade"),
    })
    .id(["childId", "parentId"]);
  const node = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      parents: s
        .toMany(() => node)
        .name("nodeGraph")
        .through(() => link)
        .source("child")
        .target("parent"),
      children: s.toMany(() => node).name("nodeGraph"),
      parentLinks: s.toMany(() => link).name("child"),
      childLinks: s.toMany(() => link).name("parent"),
    })
    .unique(["organizationId", "id"]);
  return { link, node };
};

export function runThroughModelBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}): void {
  describe(`${options.name} a declared model as the junction`, () => {
    const client = createClient({
      schema: throughSchema(),
      driver: options.createDriver(),
    });
    const withInverses = createClient({
      schema: throughWithInverses(),
      driver: options.createDriver(),
    });

    const parentsOf = async (id: string) =>
      (
        await client.team.findUniqueOrThrow({
          where: { id },
          include: { parents: { orderBy: { id: "asc" } } },
        })
      ).parents.map((team) => team.id);
    const links = () =>
      client.teamParent.findMany({
        orderBy: [{ childId: "asc" }, { parentId: "asc" }],
      });

    beforeAll(async () => {
      await syncLiveSchema(client);
      await syncLiveSchema(withInverses);
    });
    beforeEach(async () => {
      await client.teamParent.deleteMany({});
      await client.team.deleteMany({});
      await client.team.createMany({
        data: [
          { id: "a", organizationId: "o1" },
          { id: "b", organizationId: "o1" },
          { id: "c", organizationId: "o1" },
          { id: "x", organizationId: "o2" },
        ],
      });
    });
    afterAll(async () => {
      await client.$disconnect();
      await withInverses.$disconnect();
    });

    test("connect given a key fills the shared column from the located rows", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      const [link] = await links();
      expect(link).toMatchObject({
        organizationId: "o1",
        childId: "a",
        parentId: "b",
        note: "linked",
        remark: null,
      });
      expect(link?.createdAt).toBeInstanceOf(Date);
      expect(link?.token).toMatch(/^[0-9a-f-]{36}$/);
    });

    test("a repeated connect is idempotent and keeps the row it found", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      const [first] = await links();
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      const after = await links();
      expect(after).toHaveLength(1);
      expect(after[0]?.token).toBe(first?.token);
    });

    test("several connects in one call each take their own generated values", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: [{ id: "b" }, { id: "c" }] } },
      });
      const after = await links();
      expect(after.map((link) => link.parentId)).toEqual(["b", "c"]);
      expect(after[0]?.token).not.toBe(after[1]?.token);
    });

    test("a connect across two organizations is refused and writes nothing", async () => {
      await expect(
        client.team.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "x" } } },
        })
      ).rejects.toThrow(NestedWriteError);
      await expect(
        client.team.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "x" } } },
        })
      ).rejects.toThrow(/different values for 'organization_id'/);
      expect(await links()).toEqual([]);
    });

    test("one bad target among several refuses the whole call", async () => {
      await expect(
        client.team.update({
          where: { id: "a" },
          data: { parents: { connect: [{ id: "b" }, { id: "x" }] } },
        })
      ).rejects.toThrow(/different values for 'organization_id'/);
      expect(await links()).toEqual([]);
    });

    test("a connect from the inverse side keeps each column on its side", async () => {
      await client.team.update({
        where: { id: "b" },
        data: { children: { connect: { id: "a" } } },
      });
      expect(await links()).toMatchObject([
        { organizationId: "o1", childId: "a", parentId: "b" },
      ]);
    });

    test("a nested create and connectOrCreate write the link", async () => {
      await client.team.create({
        data: {
          id: "n",
          organizationId: "o1",
          parents: {
            create: { id: "m", organizationId: "o1" },
            connectOrCreate: [
              {
                where: { id: "a" },
                create: { id: "a", organizationId: "o1" },
              },
              {
                where: { id: "k" },
                create: { id: "k", organizationId: "o1" },
              },
            ],
          },
        },
      });
      expect(await parentsOf("n")).toEqual(["a", "k", "m"]);
      expect((await links()).map((link) => link.organizationId)).toEqual([
        "o1",
        "o1",
        "o1",
      ]);
    });

    test("a nested create in another organization is refused", async () => {
      await expect(
        client.team.update({
          where: { id: "a" },
          data: {
            parents: { create: { id: "m", organizationId: "o2" } },
          },
        })
      ).rejects.toThrow(/different values for 'organization_id'/);
      expect(await links()).toEqual([]);
    });

    test("disconnect given a key removes only that link", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: [{ id: "b" }, { id: "c" }] } },
      });
      await client.team.update({
        where: { id: "a" },
        data: { parents: { disconnect: { id: "b" } } },
      });
      expect(await parentsOf("a")).toEqual(["c"]);
    });

    test("set replaces the links, and a target elsewhere is refused", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      await client.team.update({
        where: { id: "a" },
        data: { parents: { set: [{ id: "c" }] } },
      });
      expect(await parentsOf("a")).toEqual(["c"]);
      await expect(
        client.team.update({
          where: { id: "a" },
          data: { parents: { set: [{ id: "x" }] } },
        })
      ).rejects.toThrow(/different values for 'organization_id'/);
      expect(await parentsOf("a")).toEqual(["c"]);
    });

    test("a nested delete, update and updateMany reach their members", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: [{ id: "b" }, { id: "c" }] } },
      });
      await client.team.update({
        where: { id: "a" },
        data: {
          parents: {
            update: { where: { id: "b" }, data: { name: "renamed" } },
            updateMany: { where: { id: "c" }, data: { name: "also" } },
          },
        },
      });
      const parents = await client.team.findMany({
        where: { children: { some: { id: "a" } } },
        orderBy: { id: "asc" },
      });
      expect(parents.map((team) => team.name)).toEqual(["renamed", "also"]);
      await client.team.update({
        where: { id: "a" },
        data: { parents: { delete: { id: "b" } } },
      });
      expect(await parentsOf("a")).toEqual(["c"]);
      expect(
        await client.team.findUnique({ where: { id: "b" } })
      ).toBeNull();
    });

    test("an include returns the target rows and no junction column", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      const found = await client.team.findUniqueOrThrow({
        where: { id: "a" },
        include: { parents: true },
      });
      expect(found.parents).toEqual([
        { id: "b", organizationId: "o1", name: "team" },
      ]);
    });

    test("filters, counts and the model's own delegate read the same links", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: [{ id: "b" }, { id: "c" }] } },
      });
      expect(
        await client.team.count({ where: { parents: { some: { id: "b" } } } })
      ).toBe(1);
      expect(
        await client.team.count({ where: { parents: { none: {} } } })
      ).toBe(3);
      expect(
        await client.team.count({
          where: { parents: { every: { organizationId: "o1" } } },
        })
      ).toBe(4);
      const counted = await client.team.findUniqueOrThrow({
        where: { id: "a" },
        select: { _count: { select: { parents: true } } },
      });
      expect(counted._count.parents).toBe(2);
      expect(await client.teamParent.count()).toBe(2);
      const direct = await client.teamParent.findFirstOrThrow({
        where: { parentId: "b" },
        include: { child: true, parent: true },
      });
      expect(direct.child.id).toBe("a");
      expect(direct.parent.id).toBe("b");
    });

    test("a recursive walk returns every ancestor, in projection and filter", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      await client.team.update({
        where: { id: "b" },
        data: { parents: { connect: { id: "c" } } },
      });
      const walked = await client.team.findUniqueOrThrow({
        where: { id: "a" },
        select: {
          parents: {
            select: { id: true },
            recurse: { depth: false },
          },
        },
      });
      expect(walked).toEqual({
        parents: [{ id: "b", parents: [{ id: "c", parents: [] }] }],
      });
      const reaching = await client.team.findMany({
        where: {
          parents: { recurse: { depth: false }, some: { id: "c" } },
        },
        orderBy: { id: "asc" },
      });
      expect(reaching.map((team) => team.id)).toEqual(["a", "b"]);
    });

    test("deleting an endpoint follows the to-one's own action", async () => {
      await client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      await client.team.delete({ where: { id: "b" } });
      expect(await links()).toEqual([]);
    });

    describe("$through", () => {
      const seed = async () => {
        await client.team.update({
          where: { id: "a" },
          data: { parents: { connect: [{ id: "b" }, { id: "c" }] } },
        });
        await client.teamParent.update({
          where: { childId_parentId: { childId: "a", parentId: "b" } },
          data: { note: "from b", remark: "first" },
        });
        await client.teamParent.update({
          where: { childId_parentId: { childId: "a", parentId: "c" } },
          data: { note: "from c" },
        });
      };

      test("an include stays the target rows; asking returns the selected columns", async () => {
        await seed();
        const plain = await client.team.findUniqueOrThrow({
          where: { id: "a" },
          include: { parents: { orderBy: { id: "asc" } } },
        });
        expect(plain.parents[0]).toEqual({
          id: "b",
          organizationId: "o1",
          name: "team",
        });
        const read = await client.team.findMany({
          where: { id: "a" },
          select: {
            id: true,
            parents: {
              orderBy: { id: "asc" },
              select: {
                id: true,
                $through: { select: { note: true, createdAt: true } },
              },
            },
          },
        });
        expect(read).toEqual([
          {
            id: "a",
            parents: [
              {
                id: "b",
                $through: { note: "from b", createdAt: expect.any(Date) },
              },
              {
                id: "c",
                $through: { note: "from c", createdAt: expect.any(Date) },
              },
            ],
          },
        ]);
      });

      test("true is every scalar of the model, in include position too", async () => {
        await seed();
        const read = await client.team.findUniqueOrThrow({
          where: { id: "a" },
          include: {
            parents: {
              where: { id: "b" },
              include: { $through: true },
            },
          },
        });
        expect(read.parents).toEqual([
          {
            id: "b",
            organizationId: "o1",
            name: "team",
            $through: {
              organizationId: "o1",
              childId: "a",
              parentId: "b",
              createdAt: expect.any(Date),
              note: "from b",
              token: expect.any(String),
              remark: "first",
            },
          },
        ]);
      });

      test("it may be all a node selects, and false asks for nothing", async () => {
        await seed();
        const only = await client.team.findUniqueOrThrow({
          where: { id: "a" },
          select: {
            parents: {
              orderBy: { id: "asc" },
              select: { $through: { select: { note: true } } },
            },
          },
        });
        expect(only.parents).toEqual([
          { $through: { note: "from b" } },
          { $through: { note: "from c" } },
        ]);
        const not = await client.team.findUniqueOrThrow({
          where: { id: "a" },
          select: {
            parents: {
              orderBy: { id: "asc" },
              select: { id: true, $through: false },
            },
          },
        });
        expect(not.parents).toEqual([{ id: "b" }, { id: "c" }]);
      });

      test("each value is the link that produced that target, under where, orderBy, take, skip", async () => {
        await seed();
        const page = (args: object) =>
          client.team.findUniqueOrThrow({
            where: { id: "a" },
            select: {
              parents: {
                ...args,
                select: {
                  id: true,
                  $through: { select: { parentId: true, note: true } },
                },
              },
            },
          });
        const down = await page({ orderBy: { id: "desc" }, take: 1 });
        expect(down.parents).toEqual([
          { id: "c", $through: { parentId: "c", note: "from c" } },
        ]);
        const skipped = await page({ orderBy: { id: "asc" }, skip: 1 });
        expect(skipped.parents).toEqual([
          { id: "c", $through: { parentId: "c", note: "from c" } },
        ]);
        const last = await page({ orderBy: { id: "asc" }, take: -1 });
        expect(last.parents).toEqual([
          { id: "c", $through: { parentId: "c", note: "from c" } },
        ]);
        const filtered = await page({ where: { id: "b" } });
        expect(filtered.parents).toEqual([
          { id: "b", $through: { parentId: "b", note: "from b" } },
        ]);
        const distinct = await page({
          orderBy: { name: "asc" },
          distinct: ["name"],
        });
        expect(distinct.parents).toHaveLength(1);
        const row = distinct.parents[0] as {
          id: string;
          $through: { parentId: string };
        };
        expect(row.$through.parentId).toBe(row.id);
      });

      test("a target shared by two parents reports each parent's own link", async () => {
        await client.team.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "c" } } },
        });
        await client.team.update({
          where: { id: "b" },
          data: { parents: { connect: { id: "c" } } },
        });
        await client.teamParent.update({
          where: { childId_parentId: { childId: "a", parentId: "c" } },
          data: { note: "a's" },
        });
        await client.teamParent.update({
          where: { childId_parentId: { childId: "b", parentId: "c" } },
          data: { note: "b's" },
        });
        const rows = await client.team.findMany({
          where: { id: { in: ["a", "b"] } },
          orderBy: { id: "asc" },
          select: {
            id: true,
            parents: { select: { id: true, $through: { select: { note: true } } } },
          },
        });
        expect(rows).toEqual([
          { id: "a", parents: [{ id: "c", $through: { note: "a's" } }] },
          { id: "b", parents: [{ id: "c", $through: { note: "b's" } }] },
        ]);
        // findUnique batches in one tick, and each key keeps its own link.
        const [first, second] = await Promise.all(
          ["a", "b"].map((id) =>
            client.team.findUnique({
              where: { id },
              select: {
                parents: {
                  select: { $through: { select: { note: true } } },
                },
              },
            })
          )
        );
        expect(first?.parents).toEqual([{ $through: { note: "a's" } }]);
        expect(second?.parents).toEqual([{ $through: { note: "b's" } }]);
      });

      test("values keep their stored types and nest through another hop", async () => {
        await seed();
        await client.team.update({
          where: { id: "b" },
          data: { parents: { connect: { id: "c" } } },
        });
        const read = await client.team.findUniqueOrThrow({
          where: { id: "a" },
          select: {
            parents: {
              where: { id: "b" },
              select: {
                $through: { select: { createdAt: true, remark: true } },
                parents: {
                  select: {
                    id: true,
                    $through: { select: { childId: true, remark: true } },
                  },
                },
              },
            },
          },
        });
        expect(read.parents).toEqual([
          {
            $through: { createdAt: expect.any(Date), remark: "first" },
            parents: [
              { id: "c", $through: { childId: "b", remark: null } },
            ],
          },
        ]);
      });

      test("a write's returned projection reads it too", async () => {
        const written = await client.team.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "b" } } },
          select: {
            parents: { select: { $through: { select: { note: true } } } },
          },
        });
        expect(written.parents).toEqual([{ $through: { note: "linked" } }]);
      });

      test("a recurse walk, a relation inside it and an unknown column are refused", async () => {
        const call = (select: object) =>
          client.team.findMany({ select: select as never });
        await expect(
          call({
            parents: {
              recurse: { depth: false },
              select: { id: true, $through: true },
            },
          })
        ).rejects.toThrow(/\$through is not available on a recurse walk/);
        await expect(
          call({
            parents: {
              select: { id: true, $through: { select: { child: true } } },
            },
          })
        ).rejects.toThrow(/Unknown key/);
        await expect(
          call({
            parents: {
              select: { id: true, $through: { select: { nope: true } } },
            },
          })
        ).rejects.toThrow(/Unknown key/);
      });
    });

    test("a side with its own inverse pairs as usual and reads both ways", async () => {
      await withInverses.link.deleteMany({});
      await withInverses.node.deleteMany({});
      await withInverses.node.createMany({
        data: [
          { id: "a", organizationId: "o1" },
          { id: "b", organizationId: "o1" },
        ],
      });
      await withInverses.node.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      const read = await withInverses.node.findUniqueOrThrow({
        where: { id: "a" },
        include: { parents: true, parentLinks: { include: { parent: true } } },
      });
      expect(read.parents.map((node) => node.id)).toEqual(["b"]);
      expect(read.parentLinks).toMatchObject([
        { childId: "a", parentId: "b", parent: { id: "b" } },
      ]);
    });
  });
}
