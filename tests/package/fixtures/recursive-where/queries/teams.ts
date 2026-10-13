// Teams in a graph through a join model: roots walked down with `recurse`
// over `children`, one team walked up over `parents` and down over
// `children`, each level carrying grants and members.
import type { Database } from "../db";
import { asMember, type Caller, may, theirGrants } from "../rules";

function leadGrants(caller: Caller) {
  const { where, select } = theirGrants(caller, {
    userId: { not: null },
    level: "full",
  });
  return { where, select: { ...select, userId: true as const } };
}

const teamFields = (caller: Caller) =>
  ({ id: true, name: true, grants: leadGrants(caller) }) as const;
const withAncestors = (caller: Caller) =>
  ({
    ...teamFields(caller),
    parents: { select: teamFields(caller), recurse: { depth: false } },
  }) as const;
const ORG_PEOPLE = {
  select: {
    userId: true,
    role: true,
    user: { select: { id: true, name: true, email: true, image: true } },
  },
} as const;
const DIRECT_MEMBERS = { members: { select: { userId: true } } } as const;

export async function teamForest(database: Database, caller: Caller) {
  const row = {
    ...teamFields(caller),
    ...DIRECT_MEMBERS,
    parents: { select: { id: true } },
  } as const;
  const mine = await database.member.findFirst({
    where: asMember(caller),
    select: {
      organization: {
        select: {
          teams: {
            where: { parents: { none: {} } },
            select: {
              ...row,
              children: { select: row, recurse: { depth: false } },
            },
          },
          members: ORG_PEOPLE,
        },
      },
    },
  });
  return mine
    ? mine.organization.teams.length + mine.organization.members.length
    : 0;
}

export async function teamById(database: Database, caller: Caller, id: string) {
  const row = await database.team.findFirst({
    where: { id, ...may.team(caller, "view") },
    select: {
      ...withAncestors(caller),
      ...DIRECT_MEMBERS,
      children: {
        select: { id: true, name: true, ...DIRECT_MEMBERS },
        recurse: { depth: false },
      },
      organization: { select: { members: ORG_PEOPLE } },
    },
  });
  return row
    ? [row.parents.length, row.children.length, row.organization.members.length]
    : null;
}
