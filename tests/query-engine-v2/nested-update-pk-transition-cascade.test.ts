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
 *    the old id would be stranded when the PK moves. The `pkTransitionCascadeSafe` guard
 *    DECLINES that shape ({@link UnsupportedOperationError}); with V1 deleted the decline
 *    is terminal (its native absorption is post-P6 backlog). Because the decline fires at
 *    construction — before any I/O — the seeded state is untouched.
 *
 * These two arms bracket the guard: remove it and the child-held arm executes and
 * strands the FK (a ForeignKeyError / wrong state, caught here as a non-decline); widen
 * it to catch m2m and the m2m arm stops executing (its state pin fails). A second root's
 * subtree is asserted untouched in every arm.
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
      `child-held deeper edge under a PK transition declines with no partial mutation (${substrate})`,
      { timeout: 30_000 },
      async () => {
        const { client } = freshClient(substrate);
        await push(client as any, { force: true });
        await seed(client);

        // The reorder/cascade trick is unsound for the NO-ACTION child FK: the shape
        // declines at construction, before any I/O — the seeded state is untouched.
        await expect(
          (client as any).node.update(op(CHILD_HELD_EDGE))
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
  }
});
