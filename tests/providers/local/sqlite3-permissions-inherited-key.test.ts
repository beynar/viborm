/**
 * R4 and a key inherited from the parent: a create rule that equates a foreign
 * key with the same key of a row it already proves readable (the parent page)
 * accepts a target the actor cannot read, and only that one. A missing target
 * and a hidden one fail alike, so the existence oracle stays closed.
 */

import { createClient } from "@drivers/sqlite3";
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
