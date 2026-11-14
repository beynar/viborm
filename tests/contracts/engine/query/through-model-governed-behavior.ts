// biome-ignore-all lint/suspicious/noMisplacedAssertion: recursiveTest registers the test these assertions run in.
import { createClient } from "@client/client";
import { defaultOmit } from "@client/default-omit-extension";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { on } from "@src/on";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import {
  type RecursionSupport,
  recursiveTest,
} from "@tests/contracts/recursion";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation/primitives/v";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const FIELD_GATED = /gates that field/;
const IS_A_JUNCTION = /junction of 'team\.parents'/;
const THIS_CLIENT = /this client/;

/**
 * A hop is storage; `$through` is a read or a write of the junction model. So
 * extensions apply to the model's delegate, never to a hop, and whatever a
 * direct call on that model would hide or judge refuses a `$through` instead of
 * being passed by. Synthetic organizations and teams.
 */
const organizations = () => {
  const organization = s.model({
    id: s.string().id(),
    teams: s.toMany(() => team),
    links: s.toMany(() => teamParent),
  });
  const teamParent = s
    .model({
      organizationId: s.string(),
      childId: s.string(),
      parentId: s.string(),
      note: s.string().default("linked"),
      secret: s.string().nullable(),
      removedAt: s.dateTime().nullable(),
      stamp: s.string().nullable(),
      organization: s
        .toOne(() => organization)
        .fields("organizationId")
        .references("id"),
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
    .id(["childId", "parentId"]);
  const team = s
    .model({
      id: s.string().id(),
      organizationId: s.string(),
      name: s.string().default("team"),
      organization: s
        .toOne(() => organization)
        .fields("organizationId")
        .references("id"),
      parents: s
        .toMany(() => team)
        .name("teamGraph")
        .through(() => teamParent)
        .source("child")
        .target("parent"),
      children: s.toMany(() => team).name("teamGraph"),
    })
    .unique(["organizationId", "id"]);
  const looseLink = s
    .model({
      childId: s.string(),
      parentId: s.string(),
      organizationId: s.string().nullable(),
      note: s.string().default("linked"),
      child: s
        .toOne(() => looseTeam)
        .fields("childId")
        .references("id")
        .onDelete("cascade"),
      parent: s
        .toOne(() => looseTeam)
        .fields("parentId")
        .references("id")
        .onDelete("cascade"),
    })
    .id(["childId", "parentId"]);
  const looseTeam = s.model({
    id: s.string().id(),
    organizationId: s.string(),
    name: s.string(),
    __through_0: s.string().default("the team's own"),
    parents: s
      .toMany(() => looseTeam)
      .name("looseGraph")
      .through(() => looseLink)
      .source("child")
      .target("parent"),
    children: s.toMany(() => looseTeam).name("looseGraph"),
  });
  return { organization, team, teamParent, looseTeam, looseLink };
};

const Actor = v.object({ organizationId: v.string() });

export function runThroughModelGovernedBehavior(
  options: RecursionSupport & {
    readonly name: string;
    readonly createDriver: () => AnyDriver;
    readonly prepare?: (client: never) => Promise<void>;
  }
): void {
  describe(`${options.name} extensions over a declared junction`, () => {
    const schema = organizations();
    const base = createClient({ schema, driver: options.createDriver() });
    const loose = base as any;

    beforeAll(async () => {
      if (!options.prepare) await syncLiveSchema(base);
    });
    beforeEach(async () => {
      if (options.prepare) await options.prepare(base as never);
      await base.teamParent.deleteMany({});
      await base.team.deleteMany({});
      await base.organization.deleteMany({});
      await base.organization.createMany({
        data: [{ id: "o1" }, { id: "o2" }],
      });
      await base.team.createMany({
        data: [
          { id: "a", organizationId: "o1" },
          { id: "b", organizationId: "o1", name: "root" },
          { id: "x", organizationId: "o2" },
          { id: "y", organizationId: "o2", name: "root" },
        ],
      });
      await base.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b" } } },
      });
      await base.team.update({
        where: { id: "x" },
        data: { parents: { connect: { id: "y" } } },
      });
    });
    afterAll(async () => {
      await base.$disconnect();
    });

    const reading = (client: any) =>
      client.team.findMany({
        select: { id: true, parents: { select: { $through: true } } },
      });
    const filtering = (client: any, where: object = { note: "linked" }) =>
      client.team.findMany({
        where: { parents: { some: { $through: where } } },
        select: { id: true },
      });
    const nestedFiltering = (client: any) =>
      client.team.findMany({
        select: {
          id: true,
          parents: { where: { $through: { note: "linked" } } },
        },
      });
    const writing = (client: any, $through: object = { note: "mine" }) =>
      client.team.update({
        where: { id: "a" },
        data: { parents: { connect: { id: "b", $through } } },
      });

    test("softDelete of a junction model is refused when it is applied", () => {
      const config = { models: { teamParent: { deletedAt: "removedAt" } } };
      expect(() => loose.$extends(softDelete(config as never))).toThrow(
        IS_A_JUNCTION
      );
      expect(() =>
        loose.$extends((softDelete(config as never) as any).rows)
      ).toThrow(IS_A_JUNCTION);
    });

    test("rows apply to the delegate, leave hops alone, and refuse $through", async () => {
      const scoped = loose.$extends({
        name: "hide",
        rows: {
          models: {
            teamParent: {
              on: {
                root: { note: "visible" },
                related: { note: "visible" },
              },
            },
          },
          default: "on",
        },
      });
      expect(await scoped.teamParent.findMany({})).toEqual([]);
      const hop = await scoped.team.findUnique({
        where: { id: "a" },
        include: { parents: true },
      });
      expect(hop.parents.map((team: { id: string }) => team.id)).toEqual(["b"]);
      await expect(
        scoped.team.count({ where: { parents: { some: { id: "b" } } } })
      ).resolves.toBe(1);
      await expect(reading(scoped)).rejects.toThrow(THIS_CLIENT);
      await expect(filtering(scoped)).rejects.toThrow(THIS_CLIENT);
      await expect(nestedFiltering(scoped)).rejects.toThrow(THIS_CLIENT);
      await expect(writing(scoped)).rejects.toThrow(THIS_CLIENT);
      // The plain write is the hop's storage.
      await scoped.team.update({
        where: { id: "b" },
        data: { parents: { connect: { id: "a" } } },
      });
      expect(await base.teamParent.count({ where: { childId: "b" } })).toBe(1);
    });

    test("a permissions rule on the junction refuses under $as, and not on the base", async () => {
      const governed = loose.$extends(
        permissions({
          actor: Actor,
          models: {
            organization: { read: true },
            team: {
              read: { organizationId: { actor: "organizationId" } },
              update: { organizationId: { actor: "organizationId" } },
            },
            teamParent: { read: { note: "visible" } },
          },
        } as never)
      );
      const call = governed.$as({ organizationId: "o1" });
      await expect(reading(call)).rejects.toThrow(THIS_CLIENT);
      await expect(filtering(call)).rejects.toThrow(THIS_CLIENT);
      await expect(writing(call)).rejects.toThrow(THIS_CLIENT);
      await expect(
        call.team.findMany({ select: { id: true, parents: true } })
      ).resolves.toEqual([
        {
          id: "a",
          parents: [{ id: "b", organizationId: "o1", name: "root" }],
        },
        { id: "b", parents: [] },
      ]);
    });

    test("a read-gated field refuses only where it is named", async () => {
      const governed = loose.$extends(
        permissions({
          actor: Actor,
          models: {
            organization: { read: true },
            team: { read: true, update: true },
            teamParent: {
              read: true,
              update: { organizationId: "nobody" },
              fields: { secret: { read: "update" } },
            },
          },
        } as never)
      );
      const call = governed.$as({ organizationId: "o1" });
      await expect(
        call.team.findMany({
          select: {
            parents: { select: { $through: { select: { secret: true } } } },
          },
        })
      ).rejects.toThrow(FIELD_GATED);
      await expect(
        call.team.findMany({
          where: { parents: { some: { $through: { secret: "x" } } } },
        })
      ).rejects.toThrow(FIELD_GATED);
      const read = await call.team.findMany({
        where: { id: "a" },
        select: {
          parents: { select: { $through: { select: { note: true } } } },
        },
      });
      expect(read).toEqual([{ parents: [{ $through: { note: "linked" } }] }]);
    });

    test("defaultOmit shapes $through: true; a stated select stands", async () => {
      await base.teamParent.updateMany({ data: { secret: "s" } });
      const omitted = loose.$extends(
        (defaultOmit as any)()({ teamParent: { secret: true } })
      );
      const row = await omitted.team.findUnique({
        where: { id: "a" },
        select: { parents: { select: { $through: true } } },
      });
      expect(row.parents[0].$through).not.toHaveProperty("secret");
      expect(row.parents[0].$through.note).toBe("linked");
      const stated = await omitted.team.findUnique({
        where: { id: "a" },
        select: {
          parents: { select: { $through: { select: { secret: true } } } },
        },
      });
      expect(stated.parents[0].$through).toEqual({ secret: "s" });
    });

    test("a write hook on the junction: a hop fires none, and $through is refused", async () => {
      const seen: string[] = [];
      const hooked = loose.$extends(
        (on as any)({
          teamParent: {
            create: () => seen.push("created"),
            update: () => seen.push("updated"),
          },
        })
      );
      await hooked.team.update({
        where: { id: "b" },
        data: { parents: { connect: { id: "a" } } },
      });
      expect(seen).toEqual([]);
      await expect(writing(hooked)).rejects.toThrow(THIS_CLIENT);
    });

    test("a stamp on the junction: a hop takes none, and $through is refused", async () => {
      const stamped = loose.$extends({
        name: "stamp",
        data: { models: { teamParent: { create: { stamp: "stamped" } } } },
      });
      await stamped.team.update({
        where: { id: "b" },
        data: { parents: { connect: { id: "a" } } },
      });
      const [plain] = await base.teamParent.findMany({
        where: { childId: "b" },
      });
      expect(plain?.stamp).toBeNull();
      await expect(writing(stamped)).rejects.toThrow(THIS_CLIENT);
      const direct = await stamped.teamParent.create({
        data: { organizationId: "o2", childId: "y", parentId: "x" },
      });
      expect(direct.stamp).toBe("stamped");
    });

    test("a policy's own rule may filter on the link row it governs", async () => {
      await base.teamParent.updateMany({
        where: { childId: "a" },
        data: { note: "visible" },
      });
      const governed = loose
        .$extends(
          permissions({
            actor: Actor,
            models: {
              organization: { read: true },
              team: {
                read: {
                  OR: [
                    { parents: { some: { $through: { note: "visible" } } } },
                    { name: "root" },
                  ],
                },
              },
              teamParent: { read: { note: "visible" } },
            },
          } as never)
        )
        .$as({ organizationId: "o1" });
      const rows = await governed.team.findMany({
        orderBy: { id: "asc" },
        select: { id: true },
      });
      expect(rows.map((row: { id: string }) => row.id)).toEqual([
        "a",
        "b",
        "y",
      ]);
      // A caller's own filter on that model is still the oracle it refuses.
      await expect(filtering(governed)).rejects.toThrow(THIS_CLIENT);
    });

    test("a rule's $through filter read twice in one statement holds on one link each time", async () => {
      await base.teamParent.updateMany({
        where: { childId: "a" },
        data: { note: "visible" },
      });
      await base.team.create({
        data: {
          id: "c",
          organizationId: "o1",
          name: "root",
          parents: { connect: { id: "b" } },
        },
      });
      const governed = loose
        .$extends(
          permissions({
            actor: Actor,
            models: {
              organization: { read: true },
              team: {
                read: {
                  OR: [
                    {
                      parents: {
                        some: { name: "root", $through: { note: "visible" } },
                      },
                    },
                    { name: "root" },
                  ],
                },
              },
              teamParent: { read: { note: "visible" } },
            },
          } as never)
        )
        .$as({ organizationId: "o1" });
      // `c` is a root and its link is hidden, `a` holds both on one link: the
      // rule reads at the root, again on `children`, and again on `parents`.
      const rows = await governed.team.findMany({
        where: { organizationId: "o1" },
        orderBy: { id: "asc" },
        select: {
          id: true,
          children: { orderBy: { id: "asc" }, select: { id: true } },
          parents: { orderBy: { id: "asc" }, select: { id: true } },
        },
      });
      expect(rows).toEqual([
        { id: "a", children: [], parents: [{ id: "b" }] },
        { id: "b", children: [{ id: "a" }, { id: "c" }], parents: [] },
        { id: "c", children: [], parents: [{ id: "b" }] },
      ]);
    });

    test("a hook on the parent model keeps $through in the caller's projection", async () => {
      const seen: unknown[] = [];
      const hooked = loose.$extends(
        (on as any)({ team: { update: (event: unknown) => seen.push(event) } })
      );
      const written = await hooked.team.update({
        where: { id: "a" },
        data: { name: "renamed" },
        select: {
          parents: { select: { $through: { select: { note: true } } } },
        },
      });
      expect(written).toEqual({
        parents: [{ $through: { note: "linked" } }],
      });
      expect(seen).toHaveLength(1);
    });

    describe("permissions({ tenant }) over a junction holding its field", () => {
      const governed = () =>
        loose.$extends(
          permissions({
            actor: Actor,
            tenant: { field: "organizationId", actor: "organizationId" },
            models: {
              organization: { read: true },
              team: {
                mandatory: { organizationId: { actor: "organizationId" } },
                read: {
                  OR: [
                    { name: "root" },
                    {
                      parents: {
                        recurse: { depth: false },
                        some: { name: "root" },
                      },
                    },
                  ],
                },
              },
            },
          } as never)
        );
      const ids = async (client: any, where?: object) =>
        (
          await client.team.findMany({
            ...(where && { where }),
            orderBy: { id: "asc" },
            select: { id: true },
          })
        ).map((team: { id: string }) => team.id);

      recursiveTest(
        options,
        "a bounded walk reads its tenant and answers the same for each",
        async () => {
          const db = governed();
          expect(await ids(db.$as({ organizationId: "o1" }))).toEqual([
            "a",
            "b",
          ]);
          expect(await ids(db.$as({ organizationId: "o2" }))).toEqual([
            "x",
            "y",
          ]);
        }
      );

      recursiveTest(
        options,
        "the negative tests see every link, so no bound narrows them",
        async () => {
          const db = governed().$as({ organizationId: "o1" });
          expect(
            await ids(db, { parents: { none: { name: "root" } } })
          ).toEqual(["b"]);
          expect(
            await ids(db, { parents: { every: { name: "root" } } })
          ).toEqual(["a", "b"]);
          expect(
            await ids(db, { parents: { none: { name: "nothing" } } })
          ).toEqual(["a", "b"]);
        }
      );
    });

    describe("a junction no other relation reaches, its tenant its own column", () => {
      beforeEach(async () => {
        await base.looseLink.deleteMany({});
        await base.looseTeam.deleteMany({});
        await base.looseTeam.createMany({
          data: ["a", "b", "d"].map((id) => ({
            id,
            organizationId: "o1",
            name: id === "b" ? "root" : "team",
          })),
        });
        await base.looseLink.createMany({
          data: [
            { childId: "a", parentId: "b", organizationId: "o2", note: "ab" },
            { childId: "d", parentId: "b", organizationId: "o1", note: "db" },
          ],
        });
      });

      test("a hook on the junction refuses $through though no relation reaches it, and a hop still links", async () => {
        await base.looseLink.deleteMany({});
        const seen: string[] = [];
        const hooked = loose.$extends(
          (on as any)({
            looseLink: {
              create: () => seen.push("created"),
              update: () => seen.push("updated"),
            },
          })
        );
        await expect(
          hooked.looseTeam.update({
            where: { id: "a" },
            data: {
              parents: {
                connect: { id: "b", $through: { organizationId: "o1" } },
              },
            },
          })
        ).rejects.toThrow(THIS_CLIENT);
        expect(await base.looseLink.count()).toBe(0);
        await hooked.looseTeam.update({
          where: { id: "a" },
          data: { parents: { connect: { id: "b" } } },
        });
        expect(await base.looseLink.count()).toBe(1);
        expect(seen).toEqual([]);
      });

      test("a tenant over a column the link's keys do not hold drops no link", async () => {
        const governed = (except: readonly string[]) =>
          loose
            .$extends(
              permissions({
                actor: Actor,
                tenant: {
                  field: "organizationId",
                  actor: "organizationId",
                  except,
                },
                models: {
                  looseTeam: {
                    mandatory: { organizationId: { actor: "organizationId" } },
                    read: { parents: { some: { name: "root" } } },
                  },
                  looseLink: { read: true },
                },
              } as never)
            )
            .$as({ organizationId: "o1" });
        const ids = async (client: any) =>
          (
            await client.looseTeam.findMany({
              orderBy: { id: "asc" },
              select: { id: true },
            })
          ).map((team: { id: string }) => team.id);
        expect(await ids(governed(["looseLink"]))).toEqual(["a", "d"]);
        expect(await ids(governed([]))).toEqual(["a", "d"]);
      });

      test("a target column named as an internal alias leaves $through its own", async () => {
        expect(
          await base.looseTeam.findUniqueOrThrow({
            where: { id: "a" },
            select: {
              parents: {
                select: {
                  __through_0: true,
                  $through: { select: { note: true } },
                },
              },
            },
          })
        ).toEqual({
          parents: [
            { __through_0: "the team's own", $through: { note: "ab" } },
          ],
        });
      });
    });
  });
}
