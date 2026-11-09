/**
 * R4 and a key inherited from the parent: a create rule that equates a foreign
 * key with the same key of a row it already proves readable (the parent page)
 * accepts a target the actor cannot read, and only that one. A missing target
 * and a hidden one fail alike, so the existence oracle stays closed.
 */

import { createClient as createDriverClient } from "@client/client";
import { createClient, SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { v } from "@validation";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const LEVELS = ["read", "update"] as const;
const teamspace = s.model({
  id: s.string().id(),
  memberId: s.string(),
  pages: s.toMany(() => page),
});
const page = s.model({
  id: s.string().id(),
  teamspaceId: s.string().nullable(),
  teamspace: s
    .toOne(() => teamspace)
    .fields("teamspaceId")
    .references("id"),
  parentId: s.string().nullable(),
  parent: s
    .toOne(() => page)
    .fields("parentId")
    .references("id")
    .name("tree"),
  children: s.toMany(() => page).name("tree"),
  grants: s.toMany(() => grant),
});
const grant = s.model({
  id: s.string().id(),
  pageId: s.string(),
  page: s
    .toOne(() => page)
    .fields("pageId")
    .references("id"),
  userId: s.string(),
  level: s.string(),
});
const schema = { teamspace, page, grant };

const access = (level: string) => ({
  OR: [
    { teamspace: { is: { memberId: { actor: "userId" } } } },
    {
      parent: {
        recurse: { depth: false },
        self: true,
        some: {
          grants: {
            some: {
              userId: { actor: "userId" },
              level: { in: LEVELS.slice(LEVELS.indexOf(level as never)) },
            },
          },
        },
      },
    },
  ],
});
const policyWith = (create: unknown) =>
  permissions({
    actor: v.object({ userId: v.string() }),
    levels: LEVELS,
    models: {
      teamspace: { read: { memberId: { actor: "userId" } } },
      grant: { read: { page: "read" } },
      page: { "read, update": access, create } as never,
    },
  });
const sameTeamspace = {
  OR: [
    { teamspaceId: null, parent: { is: { teamspaceId: null } } },
    { parent: { is: { teamspaceId: { $row: "teamspaceId", up: 1 } } } },
  ],
};

describe("R4: a key equal to the readable parent's", () => {
  const base = createClient({ schema, dataDir: ":memory:" });
  beforeAll(async () => {
    await syncLiveSchema(base);
    // Bob's teamspaces; the guest is a member of none.
    await base.teamspace.createMany({
      data: [
        { id: "ts0", memberId: "bob" },
        { id: "ts1", memberId: "bob" },
      ],
    });
    await base.page.createMany({
      data: [
        { id: "R", teamspaceId: "ts0" },
        { id: "P1", teamspaceId: "ts0", parentId: "R" },
        { id: "N", teamspaceId: null },
      ],
    });
    // The guest may update P1 (and so read it), shared one page.
    await base.grant.create({
      data: { id: "G1", pageId: "P1", userId: "guest", level: "update" },
    });
    await base.grant.create({
      data: { id: "G2", pageId: "N", userId: "guest", level: "update" },
    });
  });
  afterAll(() => base.$disconnect());

  const create = (rule: unknown, data: Record<string, unknown>) =>
    base
      .$extends(policyWith(rule))
      .$as({ userId: "guest" })
      .page.create({ data: data as never });

  it("accepts the parent's hidden teamspace, and only it", async () => {
    const rule = { AND: [{ parent: "update" }, sameTeamspace] };
    await expect(
      create(rule, { id: "C1", parentId: "P1", teamspaceId: "ts0" })
    ).resolves.toMatchObject({ id: "C1", teamspaceId: "ts0" });
    // Another hidden teamspace, and one that does not exist: the same refusal.
    const hidden = await create(rule, {
      id: "C2",
      parentId: "P1",
      teamspaceId: "ts1",
    }).catch((error: unknown) => error);
    const missing = await create(rule, {
      id: "C3",
      parentId: "P1",
      teamspaceId: "zz",
    }).catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(Error);
    expect((hidden as Error).constructor).toBe((missing as Error).constructor);
    expect((hidden as { code?: string }).code).toBe(
      (missing as { code?: string }).code
    );
    // The rule's own null arm, under a parent without a teamspace.
    await expect(
      create(rule, { id: "C4", parentId: "N", teamspaceId: null })
    ).resolves.toMatchObject({ id: "C4" });
    // A null under a parent that has one: the rule refuses it.
    await expect(
      create(rule, { id: "C5", parentId: "P1", teamspaceId: null })
    ).rejects.toThrow();
    expect(
      (await base.page.findMany({ select: { id: true } })).map(({ id }) => id)
    ).toEqual(expect.arrayContaining(["C1", "C4"]));
    expect(
      await base.page.count({ where: { id: { in: ["C2", "C3", "C5"] } } })
    ).toBe(0);
  });

  it("keeps refusing a hidden target where the rule states no equality", async () => {
    const rule = { parent: "update" };
    await expect(
      create(rule, { id: "D1", parentId: "P1", teamspaceId: "ts0" })
    ).rejects.toThrow();
  });

  it("never inherits from a parent the actor cannot read", async () => {
    // The equality alone, without `parent: "update"`: only the parent's own
    // key clause proves it readable.
    const guest = base
      .$extends(policyWith(sameTeamspace))
      .$as({ userId: "guest" });
    await base.page.create({ data: { id: "H", teamspaceId: "ts1" } });
    await base.page.create({
      data: { id: "M2", parentId: "H", teamspaceId: "ts0" },
    });
    await base.grant.create({
      data: { id: "G4", pageId: "M2", userId: "guest", level: "update" },
    });
    await expect(
      guest.page.update({ where: { id: "M2" }, data: { teamspaceId: "ts1" } })
    ).rejects.toThrow();
    await expect(
      guest.page.create({
        data: { id: "C6", parentId: "H", teamspaceId: "ts1" },
      })
    ).rejects.toThrow();
    expect(
      await base.page.findUnique({
        where: { id: "M2" },
        select: { teamspaceId: true },
      })
    ).toEqual({ teamspaceId: "ts0" });
  });

  it("judges a move of the key the same way", async () => {
    const rule = { AND: [{ parent: "update" }, sameTeamspace] };
    const guest = base.$extends(policyWith(rule)).$as({ userId: "guest" });
    await base.page.create({
      data: { id: "M1", parentId: "P1", teamspaceId: "ts0" },
    });
    await base.grant.create({
      data: { id: "G3", pageId: "M1", userId: "guest", level: "update" },
    });
    await expect(
      guest.page.update({ where: { id: "M1" }, data: { teamspaceId: "ts1" } })
    ).rejects.toThrow();
    await expect(
      guest.page.update({ where: { id: "M1" }, data: { teamspaceId: "ts0" } })
    ).resolves.toMatchObject({ teamspaceId: "ts0" });
  });
});

describe("R4: an inherited key vouches only through a visible row", () => {
  const project = s.model({
    id: s.string().id(),
    memberId: s.string(),
    currentMilestoneId: s.string().nullable(),
    currentMilestone: s
      .toOne(() => milestone)
      .fields("currentMilestoneId")
      .references("id")
      .name("current"),
    milestones: s.toMany(() => milestone).name("owned"),
    tasks: s.toMany(() => task),
  });
  const milestone = s.model({
    id: s.string().id(),
    projectId: s.string(),
    project: s
      .toOne(() => project)
      .fields("projectId")
      .references("id")
      .name("owned"),
    currentOf: s.toMany(() => project).name("current"),
    tasks: s.toMany(() => task),
  });
  const task = s.model({
    id: s.string().id(),
    projectId: s.string(),
    project: s
      .toOne(() => project)
      .fields("projectId")
      .references("id"),
    milestoneId: s.string(),
    milestone: s
      .toOne(() => milestone)
      .fields("milestoneId")
      .references("id"),
  });

  it("refuses two keys inherited through each other alike, hidden or missing", async () => {
    const base = createClient({
      schema: { project, milestone, task },
      dataDir: ":memory:",
    });
    await syncLiveSchema(base);
    await base.project.create({ data: { id: "X", memberId: "bob" } });
    await base.milestone.create({ data: { id: "M", projectId: "X" } });
    await base.project.update({
      where: { id: "X" },
      data: { currentMilestoneId: "M" },
    });
    // The milestone is of the task's project, and is its current one: each
    // key is equated with the other row's, neither row readable.
    const eve = base
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: {
            project: { read: { memberId: { actor: "userId" } } },
            milestone: { read: { project: "read" } },
            task: {
              read: { project: "read" },
              create: {
                AND: [
                  {
                    milestone: {
                      is: { projectId: { $row: "projectId", up: 1 } },
                    },
                  },
                  {
                    project: {
                      is: {
                        currentMilestoneId: { $row: "milestoneId", up: 1 },
                      },
                    },
                  },
                ],
              },
            } as never,
          },
        })
      )
      .$as({ userId: "eve" });
    const hidden = await eve.task
      .create({ data: { id: "t1", projectId: "X", milestoneId: "M" } })
      .catch((error: unknown) => error);
    const missing = await eve.task
      .create({ data: { id: "t2", projectId: "Q", milestoneId: "Z" } })
      .catch((error: unknown) => error);
    expect(hidden).toBeInstanceOf(Error);
    expect((hidden as Error).message).toBe((missing as Error).message);
    expect(await base.task.count()).toBe(0);
    await base.$disconnect();
  });

  const isMember = { teamspace: { is: { memberId: { actor: "userId" } } } };
  const ownedPolicy = permissions({
    actor: v.object({ userId: v.string() }),
    models: {
      teamspace: { read: { memberId: { actor: "userId" } } },
      page: {
        "read, update": {
          OR: [{ teamspaceId: { equals: null } }, isMember],
        },
        // Under a page you edit, in its teamspace; or in a teamspace of yours.
        create: {
          OR: [{ AND: [{ parent: "update" }, sameTeamspace] }, isMember],
        },
      } as never,
      grant: { read: { page: "read" } },
    },
  });

  it("keeps a move another branch accepts under a hidden parent", async () => {
    const base = createClient({ schema, dataDir: ":memory:" });
    await syncLiveSchema(base);
    await base.teamspace.createMany({
      data: [
        { id: "bobs", memberId: "bob" },
        { id: "alices", memberId: "alice" },
      ],
    });
    await base.page.create({ data: { id: "P", teamspaceId: "bobs" } });
    await base.page.create({ data: { id: "X", parentId: "P" } });
    const alice = base.$extends(ownedPolicy).$as({ userId: "alice" });
    expect(await alice.page.count({ where: { id: "P" } })).toBe(0);
    await expect(
      alice.page.update({ where: { id: "X" }, data: { teamspaceId: "alices" } })
    ).resolves.toMatchObject({ teamspaceId: "alices" });
    await base.$disconnect();
  });
});

describe("R4: the equality costs no bound value where create proves the parent", () => {
  class Counting extends SQLite3Driver {
    readonly counts: number[] = [];
    protected override execute<T>(
      client: never,
      sql: string,
      params: unknown[],
      context?: never
    ) {
      this.counts.push(params.length);
      return super.execute<T>(client, sql, params, context);
    }
  }
  // The same rule shape, its last member comparing a value without `$row`.
  const rule = (member: Record<string, unknown>) => ({
    OR: [
      { AND: [{ parent: "update" }, { OR: [{ teamspaceId: null }, member] }] },
      { parentId: null, teamspace: { is: { memberId: { actor: "userId" } } } },
    ],
  });
  const moveCost = async (member: Record<string, unknown>) => {
    const driver = new Counting({ dataDir: ":memory:" });
    const base = createDriverClient({ schema, driver });
    await syncLiveSchema(base);
    await base.teamspace.createMany({
      data: [
        { id: "ts0", memberId: "bob" },
        { id: "ts1", memberId: "bob" },
      ],
    });
    await base.page.create({ data: { id: "R", teamspaceId: "ts0" } });
    const bob = base.$extends(policyWith(rule(member))).$as({ userId: "bob" });
    const from = driver.counts.length;
    await bob.page.update({ where: { id: "R" }, data: { teamspaceId: "ts1" } });
    const cost = Math.max(...driver.counts.slice(from));
    await base.$disconnect();
    return cost;
  };

  it("moves a root page's key with the bound values of a rule without it", async () => {
    const inherited = await moveCost({
      parent: { is: { teamspaceId: { $row: "teamspaceId", up: 1 } } },
    });
    const plain = await moveCost({
      parent: { is: { teamspaceId: { not: null } } },
    });
    expect(inherited).toBe(plain);
  });
});
