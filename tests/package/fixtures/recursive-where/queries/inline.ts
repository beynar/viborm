// The same shapes with the filters written inline (no opaque casts): helper
// objects built by generic functions and spread into the query, `recurse`
// filters over the team graph and the document tree.
import type { Database } from "../db";

const belongingTo = <U extends string>(userId: U) => ({
  OR: [
    { members: { some: { userId } } },
    { grants: { some: { userId, level: "full" as const } } },
  ],
});
const naming = <U extends string>(userId: U) => ({
  OR: [
    { userId },
    { everyone: true },
    {
      granteeTeam: {
        children: {
          recurse: { depth: false as const },
          self: true,
          some: belongingTo(userId),
        },
      },
    },
  ],
});
const upTree = <W extends object>(where: W) => ({
  parent: { recurse: { depth: false as const }, self: true, some: where },
});
const upTeams = <W extends object>(where: W) => ({
  parents: { recurse: { depth: false as const }, self: true, some: where },
});
const theirGrants = <U extends string>(userId: U) => ({
  where: {
    OR: [
      { userId },
      { everyone: true },
      {
        granteeTeam: {
          children: {
            recurse: { depth: false as const },
            self: true,
            some: belongingTo(userId),
          },
        },
      },
      { granteeRole: { not: null } },
    ],
  },
  select: {
    level: true as const,
    granteeRole: true as const,
    everyone: true as const,
  },
});
const roleHere = <U extends string>(userId: U) => ({
  select: { members: { where: { userId }, select: { role: true as const } } },
});

export async function inlinePages(
  db: Database,
  organizationId: string,
  userId: string
) {
  const levels = {
    in: ["view", "edit", "full"] as ("view" | "edit" | "full")[],
  };
  return await db.page.findMany({
    where: {
      organizationId,
      deletedAt: null,
      OR: [
        { ownerId: userId },
        {
          grants: {
            some: {
              level: { in: ["view", "edit", "full"] },
              ...naming(userId),
            },
          },
        },
        {
          personal: false,
          group: { grants: { some: { level: levels, ...naming(userId) } } },
        },
      ],
    },
    select: {
      id: true,
      title: true,
      grants: theirGrants(userId),
      organization: roleHere(userId),
    },
  });
}

export async function inlineDocuments(
  db: Database,
  organizationId: string,
  userId: string
) {
  const levels = {
    in: ["view", "edit", "full"] as ("view" | "edit" | "full")[],
  };
  return await db.document.findMany({
    where: {
      organizationId,
      OR: [
        upTree({ ownerId: userId }),
        upTree({ parentId: null, personal: false }),
        upTree({ grants: { some: { level: levels, ...naming(userId) } } }),
      ],
    },
    select: { id: true, title: true },
  });
}

export async function inlineTeams(
  db: Database,
  organizationId: string,
  userId: string
) {
  return await db.team.findMany({
    where: {
      organizationId,
      ...upTeams({
        grants: {
          some: { level: { in: ["full" as const] }, ...naming(userId) },
        },
      }),
    },
    select: { id: true, name: true },
  });
}

export async function inlineMember(db: Database, userId: string) {
  return await db.member.findFirst({
    where: { organizationId: "org", userId: "user" },
    select: {
      organization: {
        select: {
          teams: {
            where: { parents: { none: {} } },
            select: {
              id: true,
              name: true,
              grants: theirGrants(userId),
              parents: { select: { id: true } },
              children: {
                select: {
                  id: true,
                  name: true,
                  grants: theirGrants(userId),
                  parents: { select: { id: true } },
                },
                recurse: { depth: false },
              },
            },
          },
        },
      },
    },
  });
}
