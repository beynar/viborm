import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";

import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { OperationExecutor } from "@src/query-engine/write-engine/OperationExecutor";
import { UpdateOperation } from "@src/query-engine/write-engine/UpdateOperation";
import {
  postTransitionAdoptSchema,
  runPostTransitionAdoptBehavior,
} from "@tests/contracts/engine/write/post-transition-adopt-behavior";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import { expect, test } from "vitest";

/** Records every statement and its parameters, in order. The hook is the PROTECTED
 *  `execute`/`executeRaw` seam, because a transaction runs its statements through a
 *  transaction-bound driver that delegates back to exactly these two methods. */
class RecordingPGliteDriver extends PGliteDriver {
  readonly statements: { sql: string; params: unknown[] }[] = [];
  recording = false;

  protected override execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push({ sql, params });
    return super.execute<T>(client, sql, params, context);
  }

  protected override executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push({ sql, params: params ?? [] });
    return super.executeRaw<T>(client, sql, params, context);
  }
}

// The whole family on PGlite, both substrates (the driver-matrix legs live in
// tests/drivers/{sqlite3,mysql2,pg,libsql}.test.ts).
runPostTransitionAdoptBehavior({
  name: "PGlite transaction",
  pgliteMode: "transaction",
});
runPostTransitionAdoptBehavior({
  name: "PGlite atomic batch",
  pgliteMode: "atomicBatch",
});

function makeRunner(driver: PGliteDriver) {
  const schemas = createSchemaRegistry(postTransitionAdoptSchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(postTransitionAdoptSchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  return (args: Record<string, unknown>): Promise<unknown> =>
    executor.execute(
      new UpdateOperation(
        engine,
        postTransitionAdoptSchema.list as unknown as Model<any>,
        args
      ),
      createOperationExecutionContext("list", "update", engine.instrumentation)
    );
}

test("the root UPDATE precedes the adopt write, which binds the post-transition key", async () => {
  const driver = new RecordingPGliteDriver();
  const client = createClient({ schema: postTransitionAdoptSchema, driver });
  try {
    await syncLiveSchema(client);
    await client.list.create({ data: { id: 1, name: "target" } });
    await client.item.create({
      data: { id: 20, label: "free", listId: null },
    });

    driver.recording = true;
    await makeRunner(driver)({
      where: { id: 1 },
      data: { id: 5, items: { connect: { id: 20 } } },
    });
    driver.recording = false;

    const writes = driver.statements.filter(({ sql }) =>
      sql.toLowerCase().startsWith("update ")
    );
    const rootIndex = writes.findIndex(({ sql }) =>
      sql.includes("n5_pta_lists")
    );
    const adoptIndex = writes.findIndex(({ sql }) =>
      sql.includes("n5_pta_items")
    );
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    expect(adoptIndex).toBeGreaterThanOrEqual(0);
    // THE ORDERING CLAIM. The parent's key moves first; only then is the edge written.
    expect(rootIndex).toBeLessThan(adoptIndex);
    // THE VALUE CLAIM. The reparent carries 5 — the key the root UPDATE just wrote —
    // and never 1, the key it vacated. (Both appear in the stream elsewhere: the locate
    // and the reparent's own selector still speak of the pre-transition row, so this
    // asserts the parameters of the ONE statement that assigns the foreign key.)
    expect(writes[adoptIndex]?.params).toContain(5);
    expect(writes[adoptIndex]?.params).not.toContain(1);
  } finally {
    await client.$disconnect();
  }
});

test("no transition means no reordering: the adopt write keeps its pre-N5 place", async () => {
  const driver = new RecordingPGliteDriver();
  const client = createClient({ schema: postTransitionAdoptSchema, driver });
  try {
    await syncLiveSchema(client);
    await client.list.create({ data: { id: 1, name: "target" } });
    await client.item.create({
      data: { id: 20, label: "free", listId: null },
    });

    driver.recording = true;
    await makeRunner(driver)({
      where: { id: 1 },
      data: { name: "renamed", items: { connect: { id: 20 } } },
    });
    driver.recording = false;

    const writes = driver.statements.filter(({ sql }) =>
      sql.toLowerCase().startsWith("update ")
    );
    const rootIndex = writes.findIndex(({ sql }) =>
      sql.includes("n5_pta_lists")
    );
    const adoptIndex = writes.findIndex(({ sql }) =>
      sql.includes("n5_pta_items")
    );
    // `findIndex` answers -1 for "not recorded", and -1 < 0 would satisfy the ordering
    // claim below with no root UPDATE in the stream at all. Only `rootIndex` needs
    // saying: `writes[adoptIndex]?.params` on the last line is already unsatisfiable
    // at -1, so a second assertion for `adoptIndex` would guard nothing.
    expect(rootIndex).toBeGreaterThanOrEqual(0);
    // Without a referenced-key transition the adopt is an ordinary child part: the root
    // UPDATE still comes first (nothing is reordered around it), and the deferral list
    // is empty. This is the byte-identity half of the change — the new machinery is
    // reached only by the shape that needs it.
    expect(rootIndex).toBeLessThan(adoptIndex);
    expect(writes[adoptIndex]?.params).toContain(1);
  } finally {
    await client.$disconnect();
  }
});
