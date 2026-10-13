// A member read that lists a relation through the organization, with an
// `as const` select helper, then a function typed from the query's result.
import type { Database } from "../db";
import {
  asMember,
  type Caller,
  firstRole,
  type HasMember,
  levelOf,
  may,
  roleHere,
  theirGrants,
} from "../rules";

const moduleFields = (caller: Caller) =>
  ({
    id: true,
    organizationId: true,
    externalId: true,
    name: true,
    ownerId: true,
    mode: true,
    grants: theirGrants(caller),
  }) as const;

const visibleModules = (database: Database, caller: Caller) =>
  database.member.findFirst({
    where: asMember(caller),
    select: {
      role: true,
      organization: {
        select: {
          modules: {
            where: may.module(caller, "view"),
            select: moduleFields(caller),
          },
        },
      },
    },
  });

export function withLevels(
  caller: Caller,
  member: NonNullable<Awaited<ReturnType<typeof visibleModules>>>
) {
  return member.organization.modules.map(({ grants, ...module }) => ({
    ...module,
    level: levelOf(caller, member.role, module.ownerId, grants),
  }));
}

export async function modulesFor(database: Database, caller: Caller) {
  const member = await visibleModules(database, caller);
  return member ? withLevels(caller, member) : [];
}

export async function moduleFor(
  database: Pick<Database, "module"> & HasMember,
  caller: Caller,
  id: string
) {
  const found = await database.module.findFirst({
    where: { id, ...may.module(caller, "edit") },
    include: { grants: theirGrants(caller), organization: roleHere(caller) },
  });
  if (!found) {
    return null;
  }
  const { grants: _grants, organization, ...module } = found;
  return {
    module,
    level: levelOnModule(caller, firstRole(organization), found),
  };
}

const levelOnModule = (
  caller: Caller,
  role: string | undefined,
  module: {
    id: string;
    ownerId: string | null;
    grants: readonly {
      level: "view" | "edit" | "full";
      granteeRole: "admin" | "manager" | "editor" | "reader" | null;
      everyone: boolean;
    }[];
  }
) => levelOf(caller, role, module.ownerId, module.grants);
