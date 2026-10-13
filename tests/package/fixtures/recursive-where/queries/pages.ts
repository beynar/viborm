// Pages listed through the member, each with its group's grants; one page
// with grants, group grants, the caller's role and its last version.
import type { Database } from "../db";
import {
  asMember,
  type Caller,
  firstRole,
  may,
  roleHere,
  theirGrants,
} from "../rules";

const grantsOnPage = (caller: Caller) => ({
  grants: theirGrants(caller),
  group: { select: { grants: theirGrants(caller) } },
});
const LATEST = { versions: { orderBy: { number: "desc" as const }, take: 1 } };

export async function pagesFor(
  database: Database,
  caller: Caller,
  scope: "mine" | "all"
) {
  const member = await database.member.findFirst({
    where: asMember(caller),
    select: {
      role: true,
      organization: {
        select: {
          pages: {
            where: {
              deletedAt: null,
              ...may.page(caller, "view", { given: scope === "mine" }),
            },
            select: {
              id: true,
              ownerId: true,
              personal: true,
              title: true,
              icon: true,
              color: true,
              groupId: true,
              updatedAt: true,
              pins: {
                where: { userId: caller.userId },
                select: { userId: true },
              },
              grants: theirGrants(caller),
              group: {
                select: {
                  id: true,
                  label: true,
                  icon: true,
                  color: true,
                  position: true,
                  createdById: true,
                  grants: theirGrants(caller),
                },
              },
              _count: { select: { grants: true } },
            },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  return member
    ? { role: member.role, pages: member.organization.pages }
    : { role: undefined, pages: [] };
}

export async function pageById(database: Database, caller: Caller, id: string) {
  const found = await database.page.findFirst({
    where: { id, deletedAt: null, ...may.page(caller, "view") },
    include: {
      ...grantsOnPage(caller),
      organization: roleHere(caller),
      ...LATEST,
    },
  });
  if (!found) {
    return null;
  }
  const {
    versions: _versions,
    grants: _grants,
    group: _group,
    organization,
    ...page
  } = found;
  return { page, role: firstRole(organization), version: found.versions[0] };
}
