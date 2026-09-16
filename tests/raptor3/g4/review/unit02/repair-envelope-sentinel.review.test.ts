/**
 * G4-02 independent review, repair round — adversarial probes against the
 * envelope repair (review finding 3).
 *
 * `PhysicalPlan.single` is now an ADMISSIBILITY and the statement COUNT is the
 * construction's own answer at `OperationContext.dispatch`, recovered by the
 * `requiresEnvelope` sentinel. The author pins exactly one sentinel path (a
 * bind-budget split of a HOMOGENEOUS `createMany`). These cells drive the other
 * constructions the `run` doc comment claims also split — rows with different
 * presented column sets, and a row presenting none — and record what they
 * actually cost on both routes.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    name: s.string(),
    nickname: s.string().nullable(),
    age: s.int().default(7),
  })
  .map("rv2e_authors");

/** Every field optional, so a row CAN present an empty column set. */
const blank = s
  .model({
    id: s.int().id().increment(),
    label: s.string().default("d"),
    rank: s.int().nullable(),
  })
  .map("rv2e_blanks");

const schema = { author, blank };

class Recorder extends SQLite3Driver {
  readonly statements: string[] = [];
  transactionCalls = 0;
  reset() {
    this.statements.length = 0;
    this.transactionCalls = 0;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.statements.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, body, context);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world() {
  const database = new Database(":memory:");
  const driver = new Recorder({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  driver.reset();
  const engine = createCommandEngine({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, client, engine };
}

async function measure<T>(
  driver: Recorder,
  run: () => Promise<T>
): Promise<{ value: T; statements: number; transactions: number }> {
  driver.reset();
  const value = await run();
  return {
    value,
    statements: driver.statements.length,
    transactions: driver.transactionCalls,
  };
}

/** Count `restart()` calls for the duration of one call. */
async function countingRestarts<T>(run: () => Promise<T>) {
  // biome-ignore lint/suspicious/noExplicitAny: observing the private sentinel is the point.
  const prototype = OperationContext.prototype as any;
  const original = prototype.restart;
  let restarts = 0;
  prototype.restart = function counted(this: unknown, ...rest: unknown[]) {
    restarts++;
    return original.apply(this, rest);
  };
  try {
    const value = await run();
    return { value, restarts };
  } finally {
    prototype.restart = original;
  }
}

describe("G4-02 review (repair) — the envelope sentinel on a second construction", () => {
  it("createMany with different presented column sets is still ONE statement and no envelope, as shipped", async () => {
    const w = await world();
    const rows = [
      { name: "A", nickname: "a" },
      { name: "B" },
      { name: "C", nickname: "c" },
    ];
    const observed = await countingRestarts(() =>
      measure(w.driver, () => w.engine.execute("author", "createMany", { data: rows }))
    );
    // eslint-disable-next-line no-console
    console.log(
      "HETEROGENEOUS",
      JSON.stringify({
        restarts: observed.restarts,
        cost: {
          statements: observed.value.statements,
          transactions: observed.value.transactions,
        },
        value: observed.value.value,
        stored: w.database
          .prepare("SELECT name, nickname, age FROM rv2e_authors ORDER BY id")
          .all(),
      })
    );
    assert.deepEqual(observed.value.value, { count: 3 });
    assert.equal(
      w.database.prepare("SELECT COUNT(*) FROM rv2e_authors").pluck().get(),
      3
    );
    assert.deepEqual(
      w.database
        .prepare("SELECT name, nickname, age FROM rv2e_authors ORDER BY id")
        .all(),
      [
        { name: "A", nickname: "a", age: 7 },
        { name: "B", nickname: null, age: 7 },
        { name: "C", nickname: "c", age: 7 },
      ]
    );
    // MEASURED, against the `run` doc comment's claim that "two rows with
    // different column sets are two and raise the sentinel": `schema.scalars`
    // normalizes every row to the SAME column set first, so this is ONE grouped
    // INSERT with no envelope — and the cost equals the shipped engine's.
    assert.equal(observed.value.statements, 1);
    assert.equal(observed.value.transactions, 0);
    assert.equal(observed.restarts, 0);
  });

  it("a row presenting NO columns beside a valued row is still one statement on both routes", async () => {
    const w = await world();
    const observed = await countingRestarts(() =>
      measure(w.driver, () =>
        w.engine.execute("blank", "createMany", {
          data: [{}, { label: "x", rank: 2 }],
        })
      )
    );
    const shipped = await measure(w.driver, async () =>
      w.client.blank.createMany({ data: [{}, { label: "y", rank: 3 }] })
    );
    // eslint-disable-next-line no-console
    console.log(
      "EMPTYCOLUMNSET",
      JSON.stringify({
        restarts: observed.restarts,
        candidate: {
          statements: observed.value.statements,
          transactions: observed.value.transactions,
          value: observed.value.value,
        },
        shipped: {
          statements: shipped.statements,
          transactions: shipped.transactions,
          value: shipped.value,
        },
        stored: w.database
          .prepare("SELECT label, rank FROM rv2e_blanks ORDER BY id")
          .all(),
      })
    );
    assert.deepEqual(observed.value.value, { count: 2 });
    assert.equal(
      w.database.prepare("SELECT COUNT(*) FROM rv2e_blanks").pluck().get(),
      4,
      "each row written exactly once on both routes"
    );
  });

  it("the shipped engine agrees on the heterogeneous cost", async () => {
    const w = await world();
    const shipped = await measure(w.driver, async () =>
      w.client.author.createMany({
        data: [
          { name: "A", nickname: "a" },
          { name: "B" },
          { name: "C", nickname: "c" },
        ],
      })
    );
    // eslint-disable-next-line no-console
    console.log(
      "HETEROGENEOUS shipped",
      JSON.stringify({
        statements: shipped.statements,
        transactions: shipped.transactions,
        value: shipped.value,
      })
    );
    assert.deepEqual(shipped.value, { count: 3 });
  });

  it("a one-statement admitted form still shows no envelope after the repair", async () => {
    const w = await world();
    await w.client.author.createMany({
      data: [
        { name: "P", nickname: "p" },
        { name: "Q", nickname: "q" },
      ],
    });
    const observed = await countingRestarts(() =>
      measure(w.driver, () =>
        w.engine.execute("author", "updateMany", {
          where: { name: { in: ["P", "Q"] } },
          data: { age: { increment: 1 } },
          select: { name: true, age: true },
        })
      )
    );
    // eslint-disable-next-line no-console
    console.log(
      "ONESTATEMENT",
      JSON.stringify({
        restarts: observed.restarts,
        statements: observed.value.statements,
        transactions: observed.value.transactions,
        value: observed.value.value,
      })
    );
    assert.equal(observed.value.statements, 1);
    assert.equal(observed.value.transactions, 0);
    assert.equal(observed.restarts, 0);
  });
});
