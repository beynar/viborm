/**
 * G4-03 independent review probe — how many times the candidate admits.
 *
 * Plan §2.3 (adjudicated 2026-09-08, quoted by the unit's own note.md §3) is
 * ONE evaluation per admitted input. `RoutedCandidateOperation.prepareBatch()`
 * and `.execute()` each call `createCommandEngine(...)`'s entry, and each of
 * those entries runs `schema.admit(...)` (src/query-engine/raptor3/commands/
 * index.ts:37). Neither the route object nor `#resolveRouted()` memoizes the
 * ADMISSION, only the handle.
 *
 * The probe counts, per public call, how many times the route's execute/
 * prepareBatch entries are reached, and how many times an argument-level side
 * effect (a request-transform-visible operand) is evaluated by admission.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  type ClientOperationRoute,
  createCandidateRoute,
} from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
  })
  .map("g4r_adm_authors");

const schema = { author };

class CountingDriver extends SQLite3Driver {
  readonly statements: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

class BatchOnlyDriver extends CountingDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

interface Calls {
  readonly entries: string[];
}

function countingRoute(
  route: ClientOperationRoute,
  calls: Calls
): ClientOperationRoute {
  return {
    operation(model, requestedOperation, args) {
      const inner = route.operation(model, requestedOperation, args);
      const label = `${model["~"].names.ts}.${requestedOperation}`;
      calls.entries.push(`construct:${label}`);
      return {
        get preparedArgs() {
          return inner.preparedArgs;
        },
        cacheResultCodec: () => inner.cacheResultCodec(),
        prepareBatch: (context) => {
          calls.entries.push(`prepareBatch:${label}`);
          return inner.prepareBatch(context);
        },
        execute: (execution) => {
          calls.entries.push(`execute:${label}`);
          return inner.execute(execution);
        },
      };
    },
  };
}

type WorldClient = VibORMClient<{
  driver: CountingDriver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(kind: "interactive" | "batch-only") {
  const database = new Database(":memory:");
  const driver =
    kind === "interactive"
      ? new CountingDriver({ client: database })
      : new BatchOnlyDriver({ client: database });
  const calls: Calls = { entries: [] };
  const client = VibORM.create(
    { driver, schema },
    (clientSchema, clientDriver) =>
      countingRoute(createCandidateRoute(clientSchema, clientDriver), calls)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  driver.statements.length = 0;
  calls.entries.length = 0;
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { calls, client, database, driver };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

describe("G4-03 review — admission count through the array owner", () => {
  test("an array transaction on an interactive driver asks the candidate for exactly one admission per member", async () => {
    const world = await createWorld("interactive");
    await world.client.$transaction([
      world.client.author.create({
        data: { email: "one@example.test", name: "One" },
      }),
    ]);
    // One public call must reach the candidate's admitting entry exactly once.
    assert.deepEqual(
      world.calls.entries.filter((entry) => !entry.startsWith("construct:")),
      ["execute:author.create"],
      JSON.stringify(world.calls.entries)
    );
  });

  test("an array transaction on a batch-only driver asks the candidate for exactly one admission per member", async () => {
    const world = await createWorld("batch-only");
    await world.client.$transaction([
      world.client.author.createMany({
        data: [
          { email: "two@example.test", name: "Two" },
          { email: "three@example.test", name: "Three" },
        ],
      }),
    ]);
    assert.deepEqual(
      world.calls.entries.filter((entry) => !entry.startsWith("construct:")),
      ["prepareBatch:author.createMany"],
      JSON.stringify(world.calls.entries)
    );
  });
});
