import {
  BatchOnlyPGliteDriver,
  type PGliteSchemaFamily,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  createManySchema,
  runCreateManyBehavior,
} from "@tests/contracts/engine/write/create-many-behavior";
import { observeClientOperations } from "@tests/contracts/engine/write/operation-observer";

runCreateManyBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runCreateManyBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

// ---------------------------------------------------------------------------
// The dual-run oracle: root createMany through Direct and Observed (tx and forced batch),
// reset state per arm, asserting the { count } result and persisted state.
// ---------------------------------------------------------------------------

type RoutedModel = Record<string, (args: Record<string, unknown>) => unknown>;

interface Scenario {
  name: string;
  seed?: (client: ReturnType<typeof makeClient>) => PromiseLike<unknown>;
  act: (client: Record<string, RoutedModel>) => unknown;
  expectReject?: boolean;
}

function makeClient(db: PGlite) {
  return createClient({
    schema: createManySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

async function dump(client: ReturnType<typeof makeClient>) {
  const [tags, posts] = await Promise.all([
    client.tag.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { tags, posts };
}

type ArmKind = "direct" | "observed-tx" | "observed-batch";

async function runArm(
  family: PGliteSchemaFamily<typeof createManySchema>,
  kind: ArmKind,
  scenario: Scenario
) {
  await family.reset();
  const client = makeClient(family.database);
  await scenario.seed?.(client);

  let result: unknown;
  let rejected = false;
  let operations: { boundary: "direct" | "production" }[] = [];
  try {
    if (kind === "direct") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "observed-tx"
          ? new PGliteDriver({ client: family.database })
          : new BatchOnlyPGliteDriver({ client: family.database });
      const observed = observeClientOperations({
        schema: createManySchema,
        driver,
      });
      operations = observed.operations;
      result = await scenario.act(observed.client);
    }
  } catch {
    rejected = true;
  }
  const routedToObserved =
    kind === "direct" || operations.every((r) => r.boundary === "production");
  const observed = operations.length > 0;
  const state = await dump(client);
  return { result, rejected, state, routedToObserved, observed };
}

const scenarios: Scenario[] = [
  {
    name: "plain createMany",
    act: (c) =>
      c.tag!.createMany!({
        data: [
          { id: "t1", name: "a" },
          { id: "t2", name: "b" },
          { id: "t3", name: "c" },
        ],
      }),
  },
  {
    name: "multi-shape summed count",
    act: (c) =>
      c.post!.createMany!({
        data: [
          { id: "p1", title: "one" },
          { id: "p2", title: "two", userId: null },
          { id: "p3", title: "three" },
        ],
      }),
  },
  {
    name: "skipDuplicates skips a conflicting row",
    seed: (c) => c.tag.create({ data: { id: "t1", name: "existing" } }),
    act: (c) =>
      c.tag!.createMany!({
        data: [
          { id: "t1", name: "dup" },
          { id: "t2", name: "fresh" },
        ],
        skipDuplicates: true,
      }),
  },
  {
    name: "duplicate without skip rolls back",
    expectReject: true,
    act: (c) =>
      c.tag!.createMany!({
        data: [
          { id: "d1", name: "first" },
          { id: "d1", name: "second" },
        ],
      }),
  },
];

describe("write boundary createMany dual-run oracle (Direct vs Observed)", () => {
  const getFamily = usePGliteSchemaFamily(createManySchema);
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const family = getFamily();
      const direct = await runArm(family, "direct", scenario);
      const tx = await runArm(family, "observed-tx", scenario);
      const batch = await runArm(family, "observed-batch", scenario);

      expect(tx.observed).toBe(true);
      expect(batch.observed).toBe(true);
      expect(tx.routedToObserved).toBe(true);
      expect(batch.routedToObserved).toBe(true);

      expect(tx.rejected).toBe(direct.rejected);
      expect(batch.rejected).toBe(direct.rejected);
      expect(direct.rejected).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(direct.result);
        expect(batch.result).toEqual(direct.result);
      }
      expect(tx.state).toEqual(direct.state);
      expect(batch.state).toEqual(direct.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Routing: createMany operations to Observed; an empty-data createMany is still Observed's.
// ---------------------------------------------------------------------------

describe("write boundary createMany routing", () => {
  test("createMany operations to Observed and empty data is a count-0 no-op", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });

    const observed = observeClientOperations({
      schema: createManySchema,
      driver: new PGliteDriver({ client: db }),
    });
    const result = await observed.client.tag!.createMany!({ data: [] });
    expect(result).toEqual({ count: 0 });
    expect(observed.operations.at(-1)).toEqual({
      model: "tag",
      operation: "createMany",
      boundary: "production",
    });
    await client.$disconnect();
  });
});
