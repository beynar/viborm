import { PGliteDriver } from "@drivers/pglite";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";
import { batchPrimaryKeyDataflowSchema as schema } from "@tests/fixtures/batch-primary-key-dataflow-schema";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

// A private schema per arm on the worker's shared database: the Direct oracle and
// the two Observed substrates each seed their own empty tables, exactly as they
// did when each opened its own instance.
const getDirectFamily = usePGliteSchemaFamily(schema);
const getTxObservedFamily = usePGliteSchemaFamily(schema);
const getBatchObservedFamily = usePGliteSchemaFamily(schema);

type AnyClient = ReturnType<typeof getDirectFamily>["client"];

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
  const client = getDirectFamily().client;
  await seed(client);
  await runWorkload((client as any).mutableUser);
  return await snapshot(client);
}

async function runObserved(
  substrate: "tx" | "batch"
): Promise<{ state: Snapshot; engines: Set<"direct" | "production"> }> {
  const family =
    substrate === "tx" ? getTxObservedFamily() : getBatchObservedFamily();
  const fallback = family.client;
  await seed(fallback);
  // The observed client is a SECOND driver over the same database, so it must
  // name the schema the family provisioned; otherwise it would address `public`,
  // where this suite has no tables.
  const namespace = family.driver.adapter.namespace;
  const driver =
    substrate === "tx"
      ? new PGliteDriver({ client: family.database, namespace })
      : new BatchOnlyPGliteDriver({ client: family.database, namespace });
  const observed = observeClientOperations({
    schema,
    driver,
  });
  await runWorkload(observed.client.mutableUser as any);
  const state = await snapshot(fallback);
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
