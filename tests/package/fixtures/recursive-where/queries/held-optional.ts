// A filter held in a value whose type is finite, with the client's own
// `where` payloads under its OPTIONAL keys, and a conditional spread: at the
// root, inside a relation filter, and inside a nested select's `where`. The
// misspelled-key walk descends every key such a value states and stops at
// each payload, whose own optional keys would enumerate the model graph.
import type { Database } from "../db";
import type { Caller, GrantWhere } from "../rules";

type Where<M extends "user" | "team" | "member"> = NonNullable<
  NonNullable<Parameters<Database[M]["findMany"]>[0]>["where"]
>;

export interface GrantScope {
  user?: Where<"user">;
  granteeTeam?: Where<"team"> | null;
  OR?: GrantWhere[];
}

export async function heldOptional(
  database: Database,
  caller: Caller,
  scope: GrantScope,
  member?: Where<"member">
) {
  return await database.page.findMany({
    where: {
      organizationId: caller.organizationId,
      grants: { some: scope },
      ...(member === undefined
        ? {}
        : { organization: { members: { some: member } } }),
    },
    select: { id: true, grants: { where: scope, select: { level: true } } },
  });
}
