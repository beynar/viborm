// A self to-one walked upward with `recurse` in a select, each level carrying
// the caller's grants, the result flattened by a recursive generic.
import type { Database } from "../db";
import {
  asMember,
  type Caller,
  firstRole,
  may,
  roleHere,
  theirGrants,
} from "../rules";

const nodeFields = (caller: Caller) =>
  ({
    id: true,
    organizationId: true,
    parentId: true,
    ownerId: true,
    personal: true,
    title: true,
    icon: true,
    position: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
    grants: theirGrants(caller),
  }) as const;

const upward = (caller: Caller) =>
  ({ select: nodeFields(caller), recurse: { depth: false } }) as const;

const withAncestors = (caller: Caller) =>
  ({
    ...nodeFields(caller),
    sizeBytes: true,
    parent: upward(caller),
    organization: roleHere(caller),
  }) as const;

function flattenChain<T extends { readonly parent: T | null }>(
  row: T
): Omit<T, "parent">[] {
  const chain: Omit<T, "parent">[] = [];
  for (let link: T | null = row; link; link = link.parent) {
    const { parent: _, ...node } = link;
    chain.push(node);
  }
  return chain;
}

async function loadChains(
  database: Pick<Database, "document">,
  caller: Caller,
  // biome-ignore lint/complexity/noBannedTypes: an opaque where.
  where: {}
) {
  const rows = await database.document.findMany({
    where,
    select: withAncestors(caller),
  });
  return rows.map(({ organization, sizeBytes, ...row }) => {
    const chain = flattenChain(row);
    return {
      document: chain[0],
      chain,
      sizeBytes,
      role: firstRole(organization),
    };
  });
}

export const chains = (
  database: Pick<Database, "document">,
  caller: Caller,
  where: { id?: string; parentId?: string; deletedAt?: null }
) =>
  loadChains(database, caller, {
    ...where,
    organizationId: caller.organizationId,
  });

export async function documentsFor(
  database: Database,
  caller: Caller,
  scope: "mine" | "all" = "mine"
) {
  const member = await database.member.findFirst({
    where: asMember(caller),
    select: {
      role: true,
      organization: {
        select: {
          documents: {
            where: {
              deletedAt: null,
              ...may.document(caller, "view", { given: scope === "mine" }),
            },
            select: {
              ...nodeFields(caller),
              parent: upward(caller),
              pins: {
                where: { userId: caller.userId },
                select: { userId: true },
              },
              _count: { select: { grants: true } },
            },
            orderBy: [{ position: "asc" }, { createdAt: "asc" }],
          },
        },
      },
    },
  });
  return member?.organization.documents ?? [];
}
