import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import {
  createManySchema,
  runCreateManyBehavior,
} from "./create-many-behavior";
import { createV2RoutedClient } from "./v2-client-proxy";

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

runCreateManyBehavior({
  name: "PGlite transaction",
  createDriver: () => new PGliteDriver(),
});
runCreateManyBehavior({
  name: "PGlite atomic batch",
  createDriver: () => new BatchOnlyPGliteDriver(),
});

// ---------------------------------------------------------------------------
// The dual-run oracle: root createMany through V1 and V2 (tx and forced batch),
// fresh instances per arm, asserting the { count } result and persisted state.
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

type ArmKind = "v1" | "v2-tx" | "v2-batch";

async function runArm(kind: ArmKind, scenario: Scenario) {
  const db = new PGlite();
  const client = makeClient(db);
  await push(client, { force: true });
  await scenario.seed?.(client);

  let result: unknown;
  let rejected = false;
  let routes: { engine: "v1" | "v2" }[] = [];
  try {
    if (kind === "v1") {
      result = await scenario.act(
        client as unknown as Record<string, RoutedModel>
      );
    } else {
      const driver =
        kind === "v2-tx"
          ? new PGliteDriver({ client: db })
          : new BatchOnlyPGliteDriver({ client: db });
      const routed = createV2RoutedClient({
        schema: createManySchema,
        client: client as unknown as Record<string, RoutedModel>,
        driver,
      });
      routes = routed.routes;
      result = await scenario.act(routed.client);
    }
  } catch {
    rejected = true;
  }
  const routedToV2 = kind === "v1" || routes.every((r) => r.engine === "v2");
  const routed = routes.length > 0;
  const state = await dump(client);
  await client.$disconnect();
  return { result, rejected, state, routedToV2, routed };
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

describe("query-engine-v2 createMany dual-run oracle (V1 vs V2)", () => {
  for (const scenario of scenarios) {
    test(scenario.name, { timeout: 30_000 }, async () => {
      const v1 = await runArm("v1", scenario);
      const tx = await runArm("v2-tx", scenario);
      const batch = await runArm("v2-batch", scenario);

      expect(tx.routed).toBe(true);
      expect(batch.routed).toBe(true);
      expect(tx.routedToV2).toBe(true);
      expect(batch.routedToV2).toBe(true);

      expect(tx.rejected).toBe(v1.rejected);
      expect(batch.rejected).toBe(v1.rejected);
      expect(v1.rejected).toBe(scenario.expectReject === true);

      if (!scenario.expectReject) {
        expect(tx.result).toEqual(v1.result);
        expect(batch.result).toEqual(v1.result);
      }
      expect(tx.state).toEqual(v1.state);
      expect(batch.state).toEqual(v1.state);
    });
  }
});

// ---------------------------------------------------------------------------
// Routing: createMany routes to V2; an empty-data createMany is still V2's.
// ---------------------------------------------------------------------------

describe("query-engine-v2 createMany routing", () => {
  test("createMany routes to V2 and empty data is a count-0 no-op", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });

    const routed = createV2RoutedClient({
      schema: createManySchema,
      client: client as unknown as Record<string, RoutedModel>,
      driver: new PGliteDriver({ client: db }),
    });
    const result = await routed.client.tag!.createMany!({ data: [] });
    expect(result).toEqual({ count: 0 });
    expect(routed.routes.at(-1)).toEqual({
      model: "tag",
      operation: "createMany",
      engine: "v2",
    });
    await client.$disconnect();
  });
});
