import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { defaultOmit } from "@client/default-omit-extension";
import { on } from "@src/on";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation/primitives/v";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

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
  return { organization, team, teamParent };
};

const Actor = v.object({ organizationId: v.string() });

export function runThroughModelGovernedBehavior(options: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
  readonly prepare?: (client: never) => Promise<void>;
}): void {
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

    const REFUSED = /this client/;
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
        /junction of 'team\.parents'/
      );
      expect(() =>
        loose.$extends((softDelete(config as never) as any).rows)
      ).toThrow(/junction of 'team\.parents'/);
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
      await expect(reading(scoped)).rejects.toThrow(REFUSED);
      await expect(filtering(scoped)).rejects.toThrow(REFUSED);
      await expect(nestedFiltering(scoped)).rejects.toThrow(REFUSED);
      await expect(writing(scoped)).rejects.toThrow(REFUSED);
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
      await expect(reading(call)).rejects.toThrow(REFUSED);
      await expect(filtering(call)).rejects.toThrow(REFUSED);
      await expect(writing(call)).rejects.toThrow(REFUSED);
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
      ).rejects.toThrow(/gates that field/);
      await expect(
        call.team.findMany({
          where: { parents: { some: { $through: { secret: "x" } } } },
        })
      ).rejects.toThrow(/gates that field/);
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
      await expect(writing(hooked)).rejects.toThrow(REFUSED);
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
      await expect(writing(stamped)).rejects.toThrow(REFUSED);
      const direct = await stamped.teamParent.create({
        data: { organizationId: "o2", childId: "y", parentId: "x" },
      });
      expect(direct.stamp).toBe("stamped");
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

      test("a bounded walk reads its tenant and answers the same for each", async () => {
        const db = governed();
        expect(await ids(db.$as({ organizationId: "o1" }))).toEqual(["a", "b"]);
        expect(await ids(db.$as({ organizationId: "o2" }))).toEqual(["x", "y"]);
      });

      test("the negative tests see every link, so no bound narrows them", async () => {
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
      });
    });
  });
}
