import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { batchPrimaryKeyDataflowSchema as schema } from "@tests/fixtures/batch-primary-key-dataflow-schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, test } from "vitest";

function makeDirectClient(db: PGlite) {
  return createClient({
    schema,
    driver: new PGliteDriver({ client: db }),
  });
}
type AnyClient = ReturnType<typeof makeDirectClient>;

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

async function runDirect(): Promise<Snapshot> {
  const db = openBorrowedPGlite();
  const client = makeDirectClient(db);
  await syncLiveSchema(client as any);
  await seed(client);
  await runWorkload((client as any).mutableUser);
  const state = await snapshot(client);
  await client.$disconnect();
  await closeTestPGlite(db);
  return state;
}

async function runObserved(
  substrate: "tx" | "batch"
): Promise<{ state: Snapshot; engines: Set<"direct" | "production"> }> {
  const db = openBorrowedPGlite();
  const fallback = makeDirectClient(db);
  await syncLiveSchema(fallback as any);
  await seed(fallback);
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: db })
      : new BatchOnlyPGliteDriver({ client: db });
  const observed = observeClientOperations({
    schema,
    driver,
  });
  await runWorkload(observed.client.mutableUser as any);
  const state = await snapshot(fallback);
  await fallback.$disconnect();
  await closeTestPGlite(db);
  return {
    state,
    engines: new Set(
      observed.operations
        .filter((r) => r.operation === "update")
        .map((r) => r.boundary)
    ),
  };
}

describe("T4b CLASS III updated-PK dataflow witness", () => {
  test("Direct oracle produces the exact parent→child id map", async () => {
    expect(await runDirect()).toEqual(EXPECTED);
  });

  for (const substrate of ["tx", "batch"] as const) {
    test(
      `native Observed (${substrate}) threads the produced id to the right child`,
      { timeout: 30_000 },
      async () => {
        const direct = await runDirect();
        const { state, engines } = await runObserved(substrate);
        // Both transitioning updates ran natively on Observed (no Direct fallback).
        expect(engines).toEqual(new Set(["production"]));
        // Byte-identical to the Direct oracle: the produced ids landed on the right
        // children, the vacated ids (100, 300) leaked into no FK, and the untouched
        // parent 200 kept its pre-existing child.
        expect(state).toEqual(direct);
        expect(state).toEqual(EXPECTED);
        // Explicit no-wrong-row assertion: no child references a vacated or sibling id.
        for (const [, userId] of state.posts) {
          expect([100, 300]).not.toContain(userId);
        }
      }
    );
  }
});
