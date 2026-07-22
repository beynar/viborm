import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * T3b1 fixer round 1, finding #1 — the PK-transition cascade boundary.
 *
 * Mechanism 1 lets a nested to-many `update`'s located target build its own child
 * Parts, and when the target's SET rewrites its own PK it reorders the self-UPDATE
 * AFTER those child edges — the edge is written against the PRE-transition literal id
 * and the deeper FK is carried old→new by ON UPDATE CASCADE
 * (`RelationWritePart.compileTargeted`). That trick is sound only when the deeper edge
 * cascades on update:
 *
 *  - a self-**m2m** junction FK is ON UPDATE CASCADE by default (serializer) → V2 runs
 *    the whole tree natively, byte-identical to V1 (the absorbed "nested identity
 *    transition" census witness: the junction's sourceId cascades 1→7).
 *  - a **child-held** one-to-many FK defaults to NO ACTION → the edge written against
 *    the old id is stranded when the PK moves. V1 never fails (it orders the edge
 *    against the POST-transition id); native V2 raised a ForeignKeyError and rolled
 *    back — a divergence on a shape that routed to V1 before mechanism 1. The fix
 *    routes that shape back to V1 (`pkTransitionCascadeSafe`).
 *
 * These two arms bracket the guard: remove it and the child-held arm routes to V2 and
 * diverges (state mismatch); widen it to catch m2m and the m2m arm stops routing to V2
 * (route assertion fails). A second root's subtree is asserted untouched in every arm.
 */

const cascadeSchema = (() => {
  const node = s
    .model({
      id: s.int().id(),
      label: s.string(),
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

// The concrete V1 client type (the frozen-runtime escape hatch); a loose alias so the
// test's helpers can pass it around without re-inferring the schema generics.
function makeV1Client(db: PGlite) {
  return createClient({
    schema: cascadeSchema,
    driver: new PGliteDriver({ client: db }),
    queryEngine: "v1",
  });
}
type AnyClient = ReturnType<typeof makeV1Client>;

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

function v1Client(db: PGlite): AnyClient {
  return makeV1Client(db);
}

/** Run `operation` once through the frozen V1 runtime; return the resulting state. */
async function runV1(operation: unknown): Promise<Snapshot> {
  const db = new PGlite();
  const client = v1Client(db);
  await push(client as any, { force: true });
  await seed(client);
  await (client as any).node.update(operation);
  const state = await snapshot(client);
  await client.$disconnect();
  return state;
}

/**
 * Run `operation` through the V2 router (with a true-V1 fallback) on the given
 * substrate; return the resulting state and which engine served the tree.
 */
async function runV2(
  operation: unknown,
  substrate: "tx" | "batch"
): Promise<{ state: Snapshot; engines: Set<"v1" | "v2"> }> {
  const db = new PGlite();
  const fallback = v1Client(db);
  await push(fallback as any, { force: true });
  await seed(fallback);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const routed = createV2RoutedClient({
    schema: cascadeSchema,
    client: fallback as unknown as Record<string, any>,
    driver,
  });
  await routed.client.node!.update!(operation as Record<string, unknown>);
  const state = await snapshot(fallback);
  await fallback.$disconnect();
  return { state, engines: new Set(routed.routes.map((r) => r.engine)) };
}

describe("nested update PK-transition cascade boundary (finding #1)", () => {
  for (const substrate of ["tx", "batch"] as const) {
    test(
      `child-held deeper edge under a PK transition routes to V1 and matches (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const v1 = await runV1(op(CHILD_HELD_EDGE));
        // V1's post-transition ordering: node 1→7 keeps parent 10; node 5 reparents to 7.
        expect(v1.parents).toEqual([
          [3, 10],
          [4, 20],
          [5, 7],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        const { state, engines } = await runV2(op(CHILD_HELD_EDGE), substrate);
        // The reorder/cascade trick is unsound for the NO-ACTION child FK — the whole
        // tree routes to V1 (one engine served it, and that engine is V1).
        expect(engines).toEqual(new Set(["v1"]));
        // Byte-identical state, including the disjoint second parent (node 4 → 20).
        expect(state).toEqual(v1);
      }
    );

    test(
      `self-m2m deeper edge under a PK transition stays native and matches (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const v1 = await runV1(op(M2M_EDGE));
        // The junction FK cascades: the link written against source 1 follows the PK to 7.
        expect(v1.parents).toEqual([
          [3, 10],
          [4, 20],
          [5, null],
          [7, 10],
          [10, null],
          [20, null],
        ]);
        expect(v1.links).toContainEqual([7, [5]]);
        const { state, engines } = await runV2(op(M2M_EDGE), substrate);
        // The reorder/cascade path is load-bearing here — V2 owns the whole tree natively.
        expect(engines).toEqual(new Set(["v2"]));
        expect(state).toEqual(v1);
      }
    );
  }
});
