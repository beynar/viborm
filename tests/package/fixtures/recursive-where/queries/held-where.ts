// A `where` typed as the client's own payload, held in a variable and spread
// into a literal: at the root inside a relation filter, and inside a nested
// select's `where`. Neither spells a relation key the walk could check.
import type { Database } from "../db";
import { type Caller, naming } from "../rules";

export async function rootSpread(database: Database, caller: Caller) {
  return await database.page.findMany({
    where: {
      organizationId: caller.organizationId,
      grants: { some: { level: { in: ["edit", "full"] }, ...naming(caller) } },
    },
    select: { id: true },
  });
}

export async function nestedSpread(database: Database, caller: Caller) {
  return await database.page.findMany({
    where: { organizationId: caller.organizationId },
    select: {
      id: true,
      grants: {
        where: { level: "full", ...naming(caller) },
        select: { level: true },
      },
    },
  });
}
