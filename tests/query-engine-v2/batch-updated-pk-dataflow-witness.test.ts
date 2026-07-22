import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { batchPrimaryKeyDataflowSchema as schema } from "../fixtures/batch-primary-key-dataflow-schema";
import { createV2RoutedClient } from "./v2-client-proxy";

/**
 * T4b CLASS III — the updated-PK dataflow wrong-row witness + dual-run oracle.
 *
 * A top-level `update` (or upsert update branch) that TRANSITIONS its primary key
 * (literal rename, `{ set }`, or portable arithmetic) while a nested `create`
 * references that key must thread the POST-transition value to the fresh INSERT.
 * V2 derives that value at compile from the where-pinned pre-transition value via
 * the SAME `getUpdatedPrimaryKeyValue` arithmetic the terminal read already trusts
 * (a construction literal), and orders the INSERT AFTER the root UPDATE (a NO-ACTION
 * FK does not cascade, so the new parent row must exist first). No adapter batch-ref
 * store is needed for the updated-PK class — the produced value is compile-known.
 *
 * The witness is deliberately MULTI-ROW and MULTI-ENTRY: several disjoint parents,
 * each transitioning to a DISTINCT computed id (via a distinct op) with DISTINCTLY
 * titled children, plus a pre-existing untouched child on an untransitioned parent.
 * An off-by-one produced value, the OLD id leaking into the FK, or a cross-wire
 * between two sibling transitions would visibly corrupt the parent→child id map.
 * Each arm is proven byte-identical across the true-V1 runtime, V2 in transaction
 * mode, and V2 on a batch-only atomic driver (the substrate that cannot read an
 * intermediate result), and every transitioning update is asserted to route to V2.
 */

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

function makeV1Client(db: PGlite) {
  return createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
    queryEngine: "v1",
  });
}
type AnyClient = ReturnType<typeof makeV1Client>;

async function seed(client: AnyClient): Promise<void> {
  // Three disjoint parents. Only 100 and 300 transition; 200 is the untouched
  // control holding a PRE-EXISTING child whose FK must stay 200.
  await (client as any).mutableUser.create({ data: { id: 100, name: "A" } });
  await (client as any).mutableUser.create({ data: { id: 200, name: "B" } });
  await (client as any).mutableUser.create({ data: { id: 300, name: "C" } });
  await (client as any).mutablePost.create({
    data: { title: "keep-200", userId: 200 },
  });
}

interface Snapshot {
  users: number[];
  // [postTitle, userId] pairs, ordered by title — the parent→child id map.
  posts: [string, number][];
}

async function snapshot(client: AnyClient): Promise<Snapshot> {
  const users = await (client as any).mutableUser.findMany({
    orderBy: { id: "asc" },
  });
  const posts = await (client as any).mutablePost.findMany({
    orderBy: { title: "asc" },
  });
  return {
    users: users.map((u: any) => u.id),
    posts: posts.map((p: any) => [p.title, p.userId] as [string, number]),
  };
}

// The witness workload: two disjoint transitions in one run, each with a distinct
// op and distinct children; the produced ids (141, 600) are distinct from every
// input literal (41, 2, 100, 300) and from each other, so any mis-thread is visible.
async function runWorkload(user: {
  update: (args: Record<string, unknown>) => unknown;
}): Promise<void> {
  // 100 -> increment 41 -> 141, two children (multi-entry: both must read 141).
  await user.update({
    where: { id: 100 },
    data: {
      id: { increment: 41 },
      name: "A2",
      posts: {
        create: [{ title: "child-of-141-a" }, { title: "child-of-141-b" }],
      },
    },
  });
  // 300 -> multiply 2 -> 600, one child. A cross-wire with the 141 arm shows here.
  await user.update({
    where: { id: 300 },
    data: {
      id: { multiply: 2 },
      name: "C2",
      posts: { create: { title: "child-of-600" } },
    },
  });
}

const EXPECTED: Snapshot = {
  users: [141, 200, 600],
  posts: [
    ["child-of-141-a", 141],
    ["child-of-141-b", 141],
    ["child-of-600", 600],
    ["keep-200", 200],
  ],
};

async function runV1(): Promise<Snapshot> {
  const db = new PGlite();
  const client = makeV1Client(db);
  await push(client as any, { force: true });
  await seed(client);
  await runWorkload((client as any).mutableUser);
  const state = await snapshot(client);
  await client.$disconnect();
  return state;
}

async function runV2(
  substrate: "tx" | "batch"
): Promise<{ state: Snapshot; engines: Set<"v1" | "v2"> }> {
  const db = new PGlite();
  const fallback = makeV1Client(db);
  await push(fallback as any, { force: true });
  await seed(fallback);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const routed = createV2RoutedClient({
    schema,
    client: fallback as unknown as Record<string, any>,
    driver,
  });
  await runWorkload(routed.client.mutableUser as any);
  const state = await snapshot(fallback);
  await fallback.$disconnect();
  return {
    state,
    engines: new Set(
      routed.routes.filter((r) => r.operation === "update").map((r) => r.engine)
    ),
  };
}

describe("T4b CLASS III updated-PK dataflow witness", () => {
  test("V1 oracle produces the exact parent→child id map", async () => {
    expect(await runV1()).toEqual(EXPECTED);
  });

  for (const substrate of ["tx", "batch"] as const) {
    test(
      `native V2 (${substrate}) threads the produced id to the right child`,
      { timeout: 30_000 },
      async () => {
        const v1 = await runV1();
        const { state, engines } = await runV2(substrate);
        // Both transitioning updates ran natively on V2 (no V1 fallback).
        expect(engines).toEqual(new Set(["v2"]));
        // Byte-identical to the V1 oracle: the produced ids landed on the right
        // children, the vacated ids (100, 300) leaked into no FK, and the untouched
        // parent 200 kept its pre-existing child.
        expect(state).toEqual(v1);
        expect(state).toEqual(EXPECTED);
        // Explicit no-wrong-row assertion: no child references a vacated or sibling id.
        for (const [, userId] of state.posts) {
          expect([100, 300]).not.toContain(userId);
        }
      }
    );
  }
});
