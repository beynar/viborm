// Whole relation nodes typed as the client's own payload, read through
// `Parameters<…>` and passed back: a `select` node, an `include` node, and a
// held `select` map below a literal node. A held to-many node is the union of
// the ordinary and the recursive node, whose projection carries the asking
// key; 1.2.0 refused that key as unknown (TS2322).
import type { Database } from "../db";

type Args<M extends "team"> = NonNullable<
  Parameters<Database[M]["findMany"]>[0]
>;
type TeamSelect = NonNullable<Args<"team">["select"]>;
type TeamInclude = NonNullable<Args<"team">["include"]>;
export type GrantNode = Exclude<NonNullable<TeamSelect["grants"]>, boolean>;
export type HeldGrantInclude = Exclude<
  NonNullable<TeamInclude["grants"]>,
  boolean
>;

export async function heldNodes(
  database: Database,
  grantNode: GrantNode,
  grantInclude: HeldGrantInclude,
  teamSelect: TeamSelect
) {
  const selected = await database.team.findMany({
    select: { id: true, grants: grantNode, children: { select: teamSelect } },
  });
  const included = await database.team.findMany({
    include: { grants: grantInclude },
  });
  return selected.map((team) => team.id).concat(included.map((t) => t.name));
}
