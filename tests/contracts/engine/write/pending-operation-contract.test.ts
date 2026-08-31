import { PGliteDriver } from "@drivers/pglite";

import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import {
  correlatedUpsertArgs,
  updateSliceSchema,
} from "@tests/contracts/engine/write/update-nested-upsert-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  closeTestPGlite,
  openTestPGlite as openBorrowedPGlite,
} from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { readTestTransactionOperation } from "@tests/fixtures/transaction-operation";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

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
  return engine.prepare<unknown>(updateSliceSchema.user, "update", args);
}

function transactionOperation(operation: unknown) {
  const capability = readTestTransactionOperation(operation);
  if (!capability) throw new Error("expected a transaction operation");
  return capability;
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
    const db = openBorrowedPGlite();
    const engine = engineFor(new PGliteDriver({ client: db }));
    const { createClient } = await import("@client/client");
    const client = createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "a@x", count: 10 } });

    const result = await pendingFor(engine, args);
    expect(result).toEqual(expected);
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("prepare() returns undefined for a multi-step operation", () => {
    const engine = engineFor(new PGliteDriver());
    expect(
      transactionOperation(pendingFor(engine, args)).prepare()
    ).toBeUndefined();
  });

  test("prepareBatch() RETURNS entries the shared batch protocol executes", async () => {
    const db = openBorrowedPGlite();
    const client = (await import("@client/client")).createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "a@x", count: 10 } });

    const driver = new BatchOnlyPGliteDriver({ client: db });
    const engine = engineFor(driver);
    const prepared = await transactionOperation(
      pendingFor(engine, args)
    ).prepareBatch(driver);
    // `undefined` is the executor's decline for a form with no atomic-batch
    // lowering; this fixture holds one fragment atom, which always has one.
    if (!prepared) throw new Error("the composed operation prepared no batch");

    // The seam RETURNS the prepared entries; the caller executes them as one
    // batch — exactly what the client's `$transaction([...])` merge does.
    const results = await driver._executeBatch(
      prepared.queries,
      undefined,
      undefined
    );
    const parsed = prepared.parseResult([...results]);
    expect(parsed).toEqual(expected);
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("executeWith(driver) runs linearly on a caller-provided driver", async () => {
    const db = openBorrowedPGlite();
    const client = (await import("@client/client")).createClient({
      schema: updateSliceSchema,
      driver: new PGliteDriver({ client: db }),
    });
    await syncLiveSchema(client);
    await client.user.create({ data: { email: "a@x", count: 10 } });

    // A tx-bound driver from a callback: the operation must not open a second
    // envelope. Simulate with a fresh driver on the same database.
    const bound = new PGliteDriver({ client: db });
    const engine = engineFor(bound);
    const result = await transactionOperation(
      pendingFor(engine, args)
    ).executeWith(bound);
    expect(result).toEqual(expected);
    await client.$disconnect();
    await closeTestPGlite(db);
  });

  test("parseResult(raw) parses a terminal read row set into the public shape", () => {
    const engine = engineFor(new PGliteDriver());
    const pending = pendingFor(engine, args);
    const parsed = transactionOperation(pending).parseResult({
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
