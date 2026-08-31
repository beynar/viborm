import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";

/**
 * T3b1 fixer round 1, finding #1 — the PK-transition cascade boundary, post-P6 (the
 * single engine).
 *
 * The shared bed for the three arm families, each of which now lives in its own
 * sibling file so that one process does not boot every arm's fresh database at once:
 *
 *  - `nested-update-pk-transition-cascade-ordering.test.ts` — the three arms that
 *    bracket the ORDERING mechanism (child-held, self-m2m, both kinds at once).
 *  - `nested-update-pk-transition-cascade-occupied.test.ts` — the three arms that
 *    share one OCCUPANT and differ only in the operand.
 *  - `nested-update-pk-transition-cascade-located.test.ts` — the two N4/N5 merge arms
 *    that locate the nested target by a NON-primary-key unique.
 *
 * Mechanism 1 lets a nested to-many `update`'s located target build its own child
 * Parts, and when the target's SET rewrites its own PK it reorders the self-UPDATE
 * AFTER those child edges — the edge is written against the PRE-transition literal id
 * and the deeper FK is carried old→new by ON UPDATE CASCADE
 * (`RelationWritePart.compileTargeted`). That trick is sound only when the deeper edge
 * cascades on update:
 *
 *  - a self-**m2m** junction FK is ON UPDATE CASCADE by default (serializer) → the
 *    engine runs the whole tree natively (the absorbed "nested identity transition"
 *    census witness: the junction's sourceId cascades 1→7).
 *  - a **child-held** one-to-many FK defaults to NO ACTION → the edge written against
 *    the old id would be stranded when the PK moves.
 *
 * **RETARGETED BY N5-U1 (authorized test change).** The child-held arm used to assert
 * the DECLINE, on the reasoning that "the reorder/cascade trick is unsound for the
 * NO-ACTION child FK" — true of that trick, and only of it. N5-U1 gives the non-cascade
 * case the OTHER ordering instead: the deeper edge is written against the target's
 * POST-transition primary key, AFTER the self-UPDATE, with the CLASS IV occupied guard
 * (the same one the root emits) proving no child was left behind on the vacated key. So
 * the same payload now EXECUTES, and these files assert the state it produces rather
 * than the refusal it used to raise. The occupied arm is the guard's own witness: an
 * OCCUPIED old slot is the typed occupied rejection at depth exactly as it is at the
 * root, with nothing written.
 *
 * The three ordering arms still bracket the mechanism: order the deeper edge before the
 * self-UPDATE and the child-held arm strands the FK (its state pin fails); widen the
 * non-cascade branch to catch m2m and the m2m arm stops cascading (its link pin fails);
 * drop the occupied guard and the occupied arm silently nulls a child instead of
 * rejecting. A second root's subtree is asserted untouched in every arm.
 *
 * **TWO ARMS ADDED AT THE N4/N5 MERGE.** N4-U1 lets this same nested target be located by
 * any unique, handing the deeper edges a `planned` source into the part's own probe
 * instead of a `where`-pinned literal. That absorption and N5-U1's ordering INTERSECT
 * here, and their intersection was said to be the one shape neither mechanism serves: a
 * target named by a non-primary-key unique whose SET also rewrites its primary key,
 * carrying a non-cascade deeper edge.
 *
 * **RETARGETED AGAIN BY PACKAGE D2 (authorized test change).** That intersection is
 * served now. The recorded obstacle — "no `ParentIdSource` applies the SET's operand to
 * a planned value" — was a missing SOURCE, not a missing fact:
 * `RecordUpdateCompiler.postTransitionReference` applies the operand to the located
 * value at COMPILE, per referenced member. So the first of the two merge arms executes
 * instead of refusing, and pins the state (the deeper edge on the POST-transition key,
 * the second root's subtree untouched); the second, which never had a transition, is
 * unchanged. The old measurement still holds for the mechanism it described: bind the
 * deeper edge to the located key WITHOUT the derivation and it is written against the
 * VACATED key, which the FK constraint catches here and would not catch on a schema
 * where another row already holds that key.
 *
 * **TWO ARMS ADDED IN THE FIX ROUND.** N5-U1b claimed "one rule, two depths, one
 * message" and shipped one and a half: depth read "the SET names the primary key" as
 * "the primary key transitions", so `id: { set: <current> }` and `id: { increment: 0 }`
 * dragged an occupied old slot into a rejection the ROOT does not make (`sameScalarValue`
 * is its `{ regime: "none" }`, pinned by two tests in
 * `tests/query-engine/relation-key-update-legality.test.ts`). Nothing here could catch
 * it, because the false rejection needs an OCCUPANT — with the slot empty the identical
 * payload ran, which is why the rejecting arm and these two differ only in the operand.
 * The two new arms are those root tests asked at depth; they fail 4/4 without the no-op
 * verdict, and the message they used to get asserted a transition that was not happening.
 */

export const cascadeSchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      // Unique, so the nested target can be located by a NON-primary-key unique —
      // the N4-U1 spelling the two merge arms need.
      label: s.string().unique(),
      parentId: s.int().nullable(),
      // Child-held self FK, referential action UNSET → NO ACTION on update.
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id")
        .name("tree"),
      children: s.toMany(() => node).name("tree"),
      // Self-m2m: the implicit junction FKs are ON UPDATE CASCADE by default.
      links: s
        .toMany(() => node)
        .name("link")
        .source("sourceId")
        .target("targetId"),
      linkedBy: s.toMany(() => node).name("link"),
    })
    .map("pk_transition_cascade_nodes");
  return { node };
})();

export function makeClient(driver: PGliteDriver) {
  return createClient({ schema: cascadeSchema, driver });
}
export type AnyClient = ReturnType<typeof makeClient>;

export async function seed(client: AnyClient): Promise<void> {
  // Root 10 with children 1 (the transition target) and 3 (a sibling, untouched).
  await (client as any).node.create({ data: { id: 10, label: "root-a" } });
  await (client as any).node.create({
    data: { id: 1, label: "target", parentId: 10 },
  });
  await (client as any).node.create({
    data: { id: 3, label: "sibling", parentId: 10 },
  });
  await (client as any).node.create({ data: { id: 5, label: "endpoint" } });
  // A DISJOINT second parent — its subtree must be untouched by either arm.
  await (client as any).node.create({ data: { id: 20, label: "root-b" } });
  await (client as any).node.create({
    data: { id: 4, label: "b-child", parentId: 20 },
  });
}

// Nested to-many update: target node 1 transitions its PK 1→7 while carrying a deeper
// edge that references that PK. `edge` is the deeper relation write.
export function op(edge: Record<string, unknown>) {
  return {
    where: { id: 10 },
    data: {
      children: {
        update: { where: { id: 1 }, data: { id: 7, ...edge } },
      },
    },
  } as const;
}

export const CHILD_HELD_EDGE = { children: { connect: { id: 5 } } };

export interface Snapshot {
  parents: [number, number | null][];
  links: [number, number[]][];
}

export async function snapshot(client: AnyClient): Promise<Snapshot> {
  const rows = await (client as any).node.findMany({
    orderBy: { id: "asc" },
    include: { links: { orderBy: { id: "asc" } } },
  });
  return {
    parents: rows.map((r: any) => [r.id, r.parentId ?? null]),
    links: rows.map((r: any) => [r.id, (r.links ?? []).map((l: any) => l.id)]),
  };
}

export function freshClient(substrate: "tx" | "batch"): {
  client: AnyClient;
  db: PGlite;
} {
  const db = openBorrowedPGlite();
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  return { client: makeClient(driver), db };
}
