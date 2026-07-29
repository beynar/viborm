import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { UnsupportedOperationError } from "../../src/query-engine-v2/shared";

/**
 * T3b1 fixer round 1, finding #1 — the PK-transition cascade boundary, post-P6 (the
 * single engine).
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
 * the same payload now EXECUTES, and this file asserts the state it produces rather than
 * the refusal it used to raise. The third arm below is the guard's own witness: an
 * OCCUPIED old slot is the typed occupied rejection at depth exactly as it is at the
 * root, with nothing written.
 *
 * The three arms still bracket the mechanism: order the deeper edge before the
 * self-UPDATE and the child-held arm strands the FK (its state pin fails); widen the
 * non-cascade branch to catch m2m and the m2m arm stops cascading (its link pin fails);
 * drop the occupied guard and the third arm silently nulls a child instead of rejecting.
 * A second root's subtree is asserted untouched in every arm.
 *
 * **TWO ARMS ADDED AT THE N4/N5 MERGE.** N4-U1 lets this same nested target be located by
 * any unique, handing the deeper edges a `planned` source into the part's own probe
 * instead of a `where`-pinned literal. That absorption and N5-U1's ordering INTERSECT
 * here, and their intersection is the one shape neither mechanism serves: a target named
 * by a non-primary-key unique whose SET also rewrites its primary key, carrying a
 * non-cascade deeper edge. The probe runs BEFORE the self-UPDATE, so the planned source
 * reads the key the transition is about to vacate, and no `ParentIdSource` applies the
 * SET's operand to a planned value. The last two arms bracket exactly that: the
 * intersection refuses at construction with nothing written, and the same non-PK locator
 * with NO transition in the SET executes, landing the edge on the located row's key.
 * Falsified, and the measurement is what the comment says: drop the merge refusal and the
 * deeper edge is written against the VACATED key — here the FK constraint catches it and
 * a bare `ForeignKeyError` surfaces instead of the typed construction decline (2 of 12
 * fail), and on a schema where another row already holds the vacated key nothing would
 * catch it at all.
 *
 * **TWO ARMS ADDED IN THE FIX ROUND.** N5-U1b claimed "one rule, two depths, one
 * message" and shipped one and a half: depth read "the SET names the primary key" as
 * "the primary key transitions", so `id: { set: <current> }` and `id: { increment: 0 }`
 * dragged an occupied old slot into a rejection the ROOT does not make (`sameScalarValue`
 * is its `{ regime: "none" }`, pinned by two tests in
 * `tests/query-engine/relation-key-update-legality.test.ts`). Nothing here could catch
 * it, because the false rejection needs an OCCUPANT — with the slot empty the identical
 * payload ran, which is why the arm above and these two differ only in the operand. The
 * two new arms are those root tests asked at depth; they fail 4/4 without the no-op
 * verdict, and the message they used to get asserted a transition that was not happening.
 */

const cascadeSchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      // Unique, so the nested target can be located by a NON-primary-key unique —
      // the N4-U1 spelling the two merge arms below need.
      label: s.string().unique(),
      parentId: s.int().nullable(),
      // Child-held self FK, referential action UNSET → NO ACTION on update.
      parent: s
        .manyToOne(() => node)
        .fields("parentId")
        .references("id")
        .optional(),
      children: s.oneToMany(() => node),
      // Self-m2m: the implicit junction FKs are ON UPDATE CASCADE by default.
      links: s
        .manyToMany(() => node)
        .A("sourceId")
        .B("targetId"),
      linkedBy: s.manyToMany(() => node),
    })
    .map("pk_transition_cascade_nodes");
  return { node };
})();

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function makeClient(driver: PGliteDriver) {
  return createClient({ schema: cascadeSchema, driver });
}
type AnyClient = ReturnType<typeof makeClient>;

async function seed(client: AnyClient): Promise<void> {
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
function op(edge: Record<string, unknown>) {
  return {
    where: { id: 10 },
    data: {
      children: {
        update: { where: { id: 1 }, data: { id: 7, ...edge } },
      },
    },
  } as const;
}

const CHILD_HELD_EDGE = { children: { connect: { id: 5 } } };
const M2M_EDGE = { links: { connect: { id: 5 } } };
const OCCUPIED_AT_DEPTH = /current relation is occupied/;

interface Snapshot {
  parents: [number, number | null][];
  links: [number, number[]][];
}

async function snapshot(client: AnyClient): Promise<Snapshot> {
  const rows = await (client as any).node.findMany({
    orderBy: { id: "asc" },
    include: { links: { orderBy: { id: "asc" } } },
  });
  return {
    parents: rows.map((r: any) => [r.id, r.parentId ?? null]),
    links: rows.map((r: any) => [r.id, (r.links ?? []).map((l: any) => l.id)]),
  };
}

function freshClient(substrate: "tx" | "batch"): {
  client: AnyClient;
  db: PGlite;
} {
  const db = new PGlite();
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  return { client: makeClient(driver), db };
}

describe("nested update PK-transition cascade boundary (finding #1)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `child-held deeper edge under a PK transition adopts onto the new key (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);

        // No child carries the target's key 1, so the occupied guard passes and the
        // deeper connect is written against 7 — the key the self-UPDATE just wrote.
        await (client as any).node.update(op(CHILD_HELD_EDGE));
        expect((await snapshot(client)).parents).toEqual([
          [3, 10],
          [4, 20],
          [5, 7],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );

    test(
      `an OCCUPIED old slot rejects the depth transition with nothing written (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);
        // Give the transition target a child of its own: the NO-ACTION referential
        // action would strand it, so the depth occupied guard rejects — V1's verbatim
        // wording, the same the root emits, before any write.
        await (client as any).node.create({
          data: { id: 6, label: "occupant", parentId: 1 },
        });

        await expect(
          (client as any).node.update(op(CHILD_HELD_EDGE))
        ).rejects.toThrow(OCCUPIED_AT_DEPTH);
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, null],
          [6, 1],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );

    for (const [name, operand] of [
      ["same-value set", { set: 1 }],
      ["increment zero", { increment: 0 }],
    ] as const) {
      test(
        `a ${name} on the primary key moves no slot, so an occupant is fine (${substrate})`,
        { timeout: 30_000 },
        async () => {
          const { client } = freshClient(substrate);
          await push(client as any, { force: true });
          await seed(client);
          // The SAME occupant as the arm above — the difference is only the operand.
          await (client as any).node.create({
            data: { id: 6, label: "occupant", parentId: 1 },
          });

          // The ROOT accepts exactly this rule ("allows same-value set on an occupied
          // setNull relation" / "allows increment zero …" in
          // `tests/query-engine/relation-key-update-legality.test.ts`): the SET writes
          // the key's CURRENT value, so nothing is vacated and no child is stranded.
          // Depth must answer the same, or the occupied guard's own message — which
          // says a transition is happening — is false on its face.
          await (client as any).node.update({
            where: { id: 10 },
            data: {
              children: {
                update: {
                  where: { id: 1 },
                  data: { id: operand, ...CHILD_HELD_EDGE },
                },
              },
            },
          });
          expect((await snapshot(client)).parents).toEqual([
            [1, 10],
            [3, 10],
            [4, 20],
            // The deeper connect landed on the key the target still carries …
            [5, 1],
            // … and the occupant was neither rejected nor nulled.
            [6, 1],
            [10, null],
            [20, null],
          ]);
          await client.$disconnect();
        }
      );
    }

    test(
      `both edge kinds at once is the one mix neither ordering serves (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);
        // A junction reads MEMBERSHIP at planning, correlated to the parent key, and
        // planning runs before the self-UPDATE writes the new one — so the
        // post-transition ordering the child-held edge needs would have the junction
        // read a key no row carries yet, while the pre-transition ordering the junction
        // needs strands the child-held edge. The refusal names both edges, fires at
        // construction, and leaves the seed untouched.
        await expect(
          (client as any).node.update(op({ ...CHILD_HELD_EDGE, ...M2M_EDGE }))
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, null],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );

    test(
      `self-m2m deeper edge under a PK transition executes natively (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);
        await (client as any).node.update(op(M2M_EDGE));
        const state = await snapshot(client);
        // The junction FK cascades: the link written against source 1 follows the PK to 7.
        expect(state.parents).toEqual([
          [3, 10],
          [4, 20],
          [5, null],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        expect(state.links).toContainEqual([7, [5]]);
        await client.$disconnect();
      }
    );

    test(
      `a non-PK locator plus a PK transition is the merge's one refusal (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);

        // N4-U1's provenance (locate by `label`, Ref the probe) and N5-U1b's ordering
        // (bind the deeper edge to the POST-transition key) cannot both be served: the
        // probe already ran, so the value it publishes is the key 7 replaces. Refused at
        // construction, before any statement, rather than binding the vacated key.
        await expect(
          (client as any).node.update({
            where: { id: 10 },
            data: {
              children: {
                update: {
                  where: { label: "target" },
                  data: { id: 7, ...CHILD_HELD_EDGE },
                },
              },
            },
          })
        ).rejects.toBeInstanceOf(UnsupportedOperationError);
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, null],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );

    test(
      `the same non-PK locator with no PK transition executes (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);

        // Drop the `id` from the SET and the intersection dissolves: N4-U1's planned
        // source is the whole answer, and node 5's FK lands on 1 — the key of THE ROW
        // THE PROBE LOCKED, not a value re-derived from the `where`.
        await (client as any).node.update({
          where: { id: 10 },
          data: {
            children: {
              update: {
                where: { label: "target" },
                data: { label: "renamed", ...CHILD_HELD_EDGE },
              },
            },
          },
        });
        expect((await snapshot(client)).parents).toEqual([
          [1, 10],
          [3, 10],
          [4, 20],
          [5, 1],
          [10, null],
          [20, null],
        ]);
        await client.$disconnect();
      }
    );
  }
});
