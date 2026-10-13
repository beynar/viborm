// A room with its members (through the user, back to their memberships)
// and the grants that name the caller beside every person's own.
import type { Database } from "../db";
import { type Caller, firstRole, may, roleHere, theirGrants } from "../rules";

const PERSON = (organizationId: string) =>
  ({
    userId: true,
    user: {
      select: {
        id: true,
        name: true,
        image: true,
        members: { where: { organizationId }, select: { role: true } },
      },
    },
  }) as const;

export async function roomPeople(
  database: Database,
  organizationId: string,
  roomId: string
) {
  const room = await database.room.findFirst({
    where: { id: roomId },
    select: {
      members: { select: PERSON(organizationId) },
      grants: {
        where: { userId: { not: null } },
        select: { userId: true, level: true },
      },
    },
  });
  return room ? room.members.length + room.grants.length : 0;
}

export async function roomById(database: Database, caller: Caller, id: string) {
  const reading = theirGrants(caller);
  const found = await database.room.findFirst({
    where: { id, ...may.room(caller, "view") },
    select: {
      id: true,
      name: true,
      summary: true,
      organization: roleHere(caller),
      members: { select: { ...PERSON(caller.organizationId), readSeq: true } },
      grants: {
        where: theirGrants(caller, { userId: { not: null } }).where,
        select: { ...reading.select, userId: true },
      },
    },
  });
  if (!found) {
    return null;
  }
  const theirs = found.grants.filter(
    (held) => held.userId === null || held.userId === caller.userId
  );
  return {
    role: firstRole(found.organization),
    theirs,
    mine: found.members.find((m) => m.userId === caller.userId),
  };
}
