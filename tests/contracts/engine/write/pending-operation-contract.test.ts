import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { PendingOperationV2 } from "@src/query-engine/write-engine/PendingOperationV2";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  correlatedUpsertArgs,
  updateSliceSchema,
} from "@tests/contracts/engine/write/update-nested-upsert-behavior";

function engineFor(driver: PGliteDriver) {
  return new QueryEngine(
    driver,
    createModelRegistry(
      updateSliceSchema,
      createSchemaRegistry(updateSliceSchema)
    )
  );
}

function pendingFor(engine: QueryEngine, args: Record<string, unknown>) {
  const operation = new UpdateOperation(engine, updateSliceSchema.user, args);
  const context = createOperationExecutionContext(
    "user",
    "update",
    engine.instrumentation
  );
  return new PendingOperationV2(engine, operation, context);
}

const expected = {
  email: "a@x",
  count: 13,
  posts: [{ id: 1, title: "made", slug: "made", userId: 1 }],
};

const args = correlatedUpsertArgs({
  email: "a@x",
  childId: 1,
  title: "made",
  slug: "made",
  increment: 3,
});

describe("write engine PendingOperation contract (PLAN P1.5)", () => {
  test("execute() runs the composed operation and parses its result", async () => {
    const db = new PGlite();
    const engine = engineFor(new PGliteDriver({ client: db }));
    const { createClient } = await import("@client/client");
    const client = createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await push(client, { force: true });
    await client.user.create({ data: { email: "a@x", count: 10 } });

    const result = await pendingFor(engine, args).execute();
    expect(result).toEqual(expected);
    await client.$disconnect();
  });

  test("prepare() returns undefined for a multi-step operation", () => {
    const engine = engineFor(new PGliteDriver());
    expect(pendingFor(engine, args).prepare()).toBeUndefined();
  });

  test("prepareBatch() RETURNS entries the shared batch protocol executes", async () => {
    const db = new PGlite();
    const client = (await import("@client/client")).createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await push(client, { force: true });
    await client.user.create({ data: { email: "a@x", count: 10 } });

    const driver = new BatchOnlyPGliteDriver({ client: db });
    const engine = engineFor(driver);
    const prepared = await pendingFor(engine, args).prepareBatch(driver);

    // The seam RETURNS the entries; the caller executes them as one batch.
    const queries = prepared.queries.map((statement) =>
      driver._prepare(statement)
    );
    const results = await driver._executeBatch(queries, undefined, undefined);
    const parsed = prepared.parseResult(results);
    expect(parsed).toEqual(expected);
    await client.$disconnect();
  });

  test("executeWith(driver) runs linearly on a caller-provided driver", async () => {
    const db = new PGlite();
    const client = (await import("@client/client")).createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await push(client, { force: true });
    await client.user.create({ data: { email: "a@x", count: 10 } });

    // A tx-bound driver from a callback: the operation must not open a second
    // envelope. Simulate with a fresh driver on the same database.
    const bound = new PGliteDriver({ client: db });
    const engine = engineFor(bound);
    const result = await pendingFor(engine, args).executeWith(bound);
    expect(result).toEqual(expected);
    await client.$disconnect();
  });

  test("parseResult(raw) parses a terminal read row set into the public shape", () => {
    const engine = engineFor(new PGliteDriver());
    const pending = pendingFor(engine, args);
    const parsed = pending.parseResult({
      rows: [
        {
          email: "a@x",
          count: 13,
          posts: [{ id: 1, title: "made", slug: "made", userId: 1 }],
        },
      ],
      rowCount: 1,
    });
    expect(parsed).toEqual(expected);
  });
});
