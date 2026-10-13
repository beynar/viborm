// Access-rule helpers as a consumer writes them: small functions returning
// plain `where`/`select` fragments that queries spread in. Rules are typed
// opaquely (`{ AND: {}[] }`) so the compiler never compares them whole; the
// grant filter is cast to the client's own `where` type of `accessGrant`.

import type { Database } from "./db";
import { LEVELS, ROLES } from "./schema/access";

export type Level = (typeof LEVELS)[number];
export type Role = (typeof ROLES)[number];

export interface Caller {
  readonly userId: string;
  readonly organizationId: string;
  readonly session?: string;
  readonly limit?: readonly string[];
}

type GuardedModel =
  | "page"
  | "group"
  | "collection"
  | "room"
  | "module"
  | "document"
  | "team";

// biome-ignore lint/complexity/noBannedTypes: opaque by design.
export type Rule<_M extends GuardedModel> = { AND: {}[] };
const asRule = <M extends GuardedModel>(where: { AND: readonly object[] }) =>
  where as unknown as Rule<M>;

export type GrantWhere = NonNullable<
  NonNullable<Parameters<Database["accessGrant"]["findMany"]>[0]>["where"]
>;

const covers = (held: Level, wanted: Level) =>
  LEVELS.indexOf(held) >= LEVELS.indexOf(wanted);
const levelsCovering = (level: Level) =>
  LEVELS.filter((held) => covers(held, level));
const rolesUpTo = (level: Level) =>
  ROLES.filter((role) => role !== "reader" || level === "view");

export function activeMember(caller: Caller, level: Level) {
  const now = new Date();
  return {
    userId: caller.userId,
    role: { in: rolesUpTo(level) },
    user: {
      OR: [{ banned: null }, { banned: false }, { banExpires: { lte: now } }],
      ...(caller.session === undefined
        ? {}
        : {
            sessions: {
              some: {
                id: caller.session,
                expiresAt: { gt: now },
                activeOrganizationId: caller.organizationId,
              },
            },
          }),
    },
  };
}

export const inOrg = (caller: Caller, level: Level = "view") => ({
  organizationId: caller.organizationId,
  organization: { members: { some: activeMember(caller, level) } },
});

export const asMember = (caller: Caller, level: Level = "view") => ({
  organizationId: caller.organizationId,
  ...activeMember(caller, level),
});

const withRole = (caller: Caller, role: Role) => ({
  organization: { members: { some: { userId: caller.userId, role } } },
});

export const belongingTo = (caller: Caller) => ({
  OR: [
    { members: { some: { userId: caller.userId } } },
    { grants: { some: { userId: caller.userId, level: "full" as const } } },
  ],
});

const granteesOf = (caller: Caller) => [
  { userId: caller.userId },
  { everyone: true },
  {
    granteeTeam: {
      children: {
        recurse: { depth: false as const },
        self: true,
        some: belongingTo(caller),
      },
    },
  },
];

export const naming = (caller: Caller) =>
  ({ OR: granteesOf(caller) }) as unknown as GrantWhere;

interface Guard {
  readonly owner: string | null;
  readonly personal: boolean;
  readonly through?: (grant: object) => object;
}

const GUARDED: Record<Exclude<GuardedModel, "document" | "team">, Guard> = {
  page: {
    owner: "ownerId",
    personal: true,
    through: (grant) => ({
      personal: false,
      group: { grants: { some: grant } },
    }),
  },
  group: { owner: "createdById", personal: false },
  collection: { owner: "ownerId", personal: true },
  room: { owner: null, personal: false },
  module: { owner: "ownerId", personal: false },
};

function guard<M extends Exclude<GuardedModel, "document" | "team">>(
  model: M,
  caller: Caller,
  level: Level,
  { given = false } = {}
): Rule<M> {
  const facts = GUARDED[model];
  const levels = { in: levelsCovering(level) };
  const viaGrants = (grant: object) => [
    { grants: { some: grant } },
    ...(facts.through ? [facts.through(grant)] : []),
  ];
  return asRule<M>({
    AND: [
      inOrg(caller, level),
      ...(caller.limit === undefined
        ? []
        : [{ id: { in: [...caller.limit] } }]),
      {
        OR: [
          ...(facts.owner === null ? [] : [{ [facts.owner]: caller.userId }]),
          ...(given
            ? []
            : [
                {
                  ...(facts.personal ? { personal: false } : {}),
                  ...withRole(caller, "admin"),
                },
              ]),
          ...viaGrants({ level: levels, ...naming(caller) }),
          ...rolesUpTo(level).map((role) => ({
            ...withRole(caller, role),
            OR: viaGrants({ granteeRole: role, level: levels }),
          })),
        ],
      },
    ],
  });
}

export const upTree = (where: object) => ({
  parent: { recurse: { depth: false as const }, self: true, some: where },
});
export const upTeams = (where: object) => ({
  parents: { recurse: { depth: false as const }, self: true, some: where },
});

function documentGuard(
  caller: Caller,
  level: Level,
  { given = false } = {}
): Rule<"document"> {
  const levels = { in: levelsCovering(level) };
  return asRule<"document">({
    AND: [
      inOrg(caller, level),
      {
        OR: [
          upTree({ ownerId: caller.userId }),
          ...(given
            ? []
            : [
                {
                  AND: [
                    withRole(caller, "admin"),
                    upTree({ parentId: null, personal: false }),
                  ],
                },
              ]),
          upTree({ grants: { some: { level: levels, ...naming(caller) } } }),
        ],
      },
    ],
  });
}

function teamGuard(caller: Caller, level: Level): Rule<"team"> {
  if (level === "view") {
    return asRule<"team">({ AND: [inOrg(caller, "view")] });
  }
  const levels = { in: levelsCovering(level) };
  return asRule<"team">({
    AND: [
      inOrg(caller, level),
      {
        OR: [
          withRole(caller, "admin"),
          upTeams({ grants: { some: { level: levels, ...naming(caller) } } }),
        ],
      },
    ],
  });
}

export const may = {
  page: (caller: Caller, level: Level, options?: { given?: boolean }) =>
    guard("page", caller, level, options),
  group: (caller: Caller, level: Level) => guard("group", caller, level),
  collection: (caller: Caller, level: Level) =>
    guard("collection", caller, level),
  room: (caller: Caller, level: Level, options?: { given?: boolean }) =>
    guard("room", caller, level, options),
  module: (caller: Caller, level: Level) => guard("module", caller, level),
  document: (caller: Caller, level: Level, options?: { given?: boolean }) =>
    documentGuard(caller, level, options),
  team: (caller: Caller, level: Level) => teamGuard(caller, level),
};

export const theirGrants = (caller: Caller, ...besides: object[]) => ({
  where: {
    OR: [...granteesOf(caller), { granteeRole: { not: null } }, ...besides],
  } as unknown as GrantWhere,
  select: {
    level: true as const,
    granteeRole: true as const,
    everyone: true as const,
  },
});

export const roleHere = (caller: Caller) => ({
  select: {
    members: {
      where: { userId: caller.userId },
      select: { role: true as const },
    },
  },
});

export const firstRole = (
  org:
    | { readonly members: readonly { readonly role: string }[] }
    | null
    | undefined
) => org?.members[0]?.role;

export interface GrantRow {
  readonly level: Level;
  readonly granteeRole: Role | null;
  readonly everyone: boolean;
}

export function levelOf(
  _caller: Caller,
  _role: string | undefined,
  owner: string | null,
  grants: readonly GrantRow[]
): Level {
  return owner === null ? (grants[0]?.level ?? "view") : "full";
}

export interface HasMember {
  readonly member: Pick<Database["member"], "findFirst">;
}
