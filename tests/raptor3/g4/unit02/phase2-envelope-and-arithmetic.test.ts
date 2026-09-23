/**
 * G4-02 phase 2 — the `operationRegion` grant, the scalar update language, the
 * folded root `create`, and the single-statement failure meta.
 *
 * The route file is G4-03's and still wraps every borrowed write itself
 * (note §11.3), so the region cells construct the binding the corrected route
 * will pass and pin the candidate's own side of it.
 */

import assert from "node:assert/strict";
import type { AnyDriver, QueryExecutionContext } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { NotFoundError, QueryEngineError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { createClient } from "@client/client";
import { Decimal } from "@src/index";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { cost, createWorld, worldSchema, type World } from "./world";

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

function engineOf(current: World) {
  return createCommandEngine({ schema: worldSchema, driver: current.driver });
}

/** Regions opened INSIDE a caller's transaction are savepoints, not BEGINs. */
function savepoints(driver: World["driver"]): number {
  return driver.control.filter((statement) => /^SAVEPOINT\b/i.test(statement))
    .length;
}

/** The array fallback's grant: member isolation only, no operation region. */
function memberOnly(scoped: AnyDriver) {
  return {
    kind: "borrowed-transaction",
    driver: scoped,
    memberRollback: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => scoped.withTransaction(execute, undefined, context),
  } as const;
}

/** The callback-transaction route's grant: it opened no region of its own. */
function transferred(caller: AnyDriver) {
  return {
    kind: "borrowed-transaction",
    driver: caller,
    memberRollback: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => caller.withTransaction(execute, undefined, context),
    operationRegion: <T,>(
      execute: (driver: AnyDriver) => Promise<T>,
      context: QueryExecutionContext
    ) => caller.withTransaction(execute, undefined, context),
  } as const;
}

describe("G4-02 operationRegion — ownership is stated, never inferred", () => {
  it("opens exactly one region for a multi-statement borrowed write, and none without the grant", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    const relationBearing = {
      where: { id: 1 },
      data: { name: "Ada+", posts: { create: [{ id: 20, title: "n", rank: 9 }] } },
    };

    // Granted: the candidate opens ONE region of its own.
    await driver.withTransaction(async (caller) => {
      driver.reset();
      await engine.execute(
        "author",
        "update",
        relationBearing,
        transferred(caller as AnyDriver)
      );
      const granted = cost(driver);
      assert.ok(granted.statements > 1, "a relation-bearing update is a series");
      assert.equal(
        savepoints(driver),
        1,
        `exactly one region: ${JSON.stringify(driver.control)}`
      );
    });

    // Not granted: the array fallback's member grant opens no operation region,
    // which is the shipped `runLinearOn` behavior (note §8.4).
    await driver.withTransaction(async (caller) => {
      driver.reset();
      await engine.execute(
        "author",
        "update",
        {
          where: { id: 2 },
          data: { name: "Bo+", posts: { create: [{ id: 21, title: "m", rank: 8 }] } },
        },
        memberOnly(caller as AnyDriver)
      );
      assert.equal(
        savepoints(driver),
        0,
        `a member-only grant is not an operation region: ${JSON.stringify(driver.control)}`
      );
    });
  });

  it("runs a single-statement borrowed write directly even when a region was granted", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    const driver = world.driver;
    await driver.withTransaction(async (caller) => {
      driver.reset();
      const value = await engine.execute(
        "author",
        "update",
        { where: { id: 1 }, data: { age: { increment: 1 } } },
        transferred(caller as AnyDriver)
      );
      assert.deepEqual(value, { id: 1, name: "Ada", age: 37, avatar: null });
      assert.deepEqual(cost(driver), {
        statements: 1,
        transactions: 0,
        control: 0,
      });
    });
  });
});

const ledger = s
  .model({
    id: s.int().id(),
    count: s.int(),
    ratio: s.number(),
    big: s.bigInt(),
    amount: s.decimal({ precision: 12, scale: 2 }),
    labels: s.string().array(),
  })
  .map("g4u2_ledgers");
const arithmeticSchema = { ledger };

async function arithmeticWorld() {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const client = createClient({ schema: arithmeticSchema, driver });
  assert.equal((await syncLiveSchema(client)).applied, true);
  const engine = createCommandEngine({ schema: arithmeticSchema, driver });
  await engine.execute("ledger", "create", {
    data: {
      id: 1,
      count: 12,
      ratio: 2.5,
      big: 9_007_199_254_740_993n,
      amount: "10.50",
      labels: ["a"],
    },
  });
  return {
    engine,
    database,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

describe("G4-02 scalar update language (SC-03…SC-06 write side)", () => {
  it("spells every arithmetic operator in SQL, in the provider's own vocabulary", async () => {
    const live = await arithmeticWorld();
    try {
      const updated = (await live.engine.execute("ledger", "update", {
        where: { id: 1 },
        data: {
          count: { multiply: 3 },
          ratio: { divide: 2 },
          big: { decrement: 3n },
          amount: { multiply: "2.00" },
        },
      })) as Record<string, unknown>;
      assert.equal(updated.count, 36, "int multiply");
      assert.equal(updated.ratio, 1.25, "float divide");
      assert.equal(updated.big, 9_007_199_254_740_990n, "bigint decrement");
      assert.ok(updated.amount instanceof Decimal);
      assert.equal(
        canonicalizeDecimal(updated.amount),
        "21",
        "decimal multiply, in the field's own domain"
      );
      const quantized = (await live.engine.execute("ledger", "update", {
        where: { id: 1 },
        data: { amount: { divide: "8.00" } },
      })) as Record<string, unknown>;
      assert.equal(
        canonicalizeDecimal(quantized.amount),
        "2.62",
        "21 / 8 = 2.625, quantized to the field's scale half to even"
      );
      const truncated = (await live.engine.execute("ledger", "update", {
        where: { id: 1 },
        data: { count: { divide: 5 } },
      })) as Record<string, unknown>;
      assert.equal(truncated.count, 7, "integer division truncates toward zero");
      const listed = (await live.engine.execute("ledger", "update", {
        where: { id: 1 },
        data: { labels: { push: ["b", "c"] } },
      })) as Record<string, unknown>;
      assert.deepEqual(listed.labels, ["a", "b", "c"], "push appends members");
      const unshifted = (await live.engine.execute("ledger", "update", {
        where: { id: 1 },
        data: { labels: { unshift: "z" } },
      })) as Record<string, unknown>;
      assert.deepEqual(unshifted.labels, ["z", "a", "b", "c"]);
    } finally {
      await live.close();
    }
  });

  it("refuses an exact decimal divided by zero before any statement is issued", async () => {
    const live = await arithmeticWorld();
    try {
      let failure: unknown;
      try {
        await live.engine.execute("ledger", "update", {
          where: { id: 1 },
          data: { amount: { divide: "0" } },
        });
      } catch (caught) {
        failure = caught;
      }
      assert.ok(failure instanceof QueryEngineError, String(failure));
      assert.equal(
        failure.message,
        "Cannot divide decimal field 'amount' by zero."
      );
      assert.deepEqual(
        live.database.prepare("SELECT id FROM g4u2_ledgers").all(),
        [{ id: 1 }],
        "the row is untouched"
      );
    } finally {
      await live.close();
    }
  });
});

describe("G4-02 root create folds to one statement", () => {
  it("costs one statement and no envelope, and publishes the created row", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    world.driver.reset();
    const value = await engine.execute("author", "create", {
      data: { id: 3, name: "Cy", age: 29 },
    });
    assert.deepEqual(value, { id: 3, name: "Cy", age: 29, avatar: null });
    assert.deepEqual(cost(world.driver), {
      statements: 1,
      transactions: 0,
      control: 0,
    });
    assert.equal(world.driver.roundTrips, 1);
  });

  it("keeps the qualified route when the data names a relation", async () => {
    world = await createWorld();
    const engine = engineOf(world);
    world.driver.reset();
    await engine.execute("author", "create", {
      data: {
        id: 4,
        name: "Dee",
        age: 30,
        posts: { create: [{ id: 30, title: "d", rank: 4 }] },
      },
    });
    const observed = cost(world.driver);
    assert.ok(observed.statements > 1, "a relation-bearing create is a series");
    assert.equal(observed.transactions, 1, "and keeps its envelope");
  });
});

describe("G4-02 a statement-atomic operation has no record series", () => {
  it("carries the shipped meta for a missing root delete on a batch-only driver", async () => {
    const database = new Database(":memory:");
    class BatchOnly extends SQLite3Driver {
      override readonly supportsTransactions = false;
      override readonly supportsBatch = true;
    }
    const driver = new BatchOnly({ client: database });
    const client = createClient({ schema: worldSchema, driver });
    try {
      assert.equal((await syncLiveSchema(client)).applied, true);
      const engine = createCommandEngine({ schema: worldSchema, driver });
      await engine.execute("author", "create", { data: { id: 1, name: "A", age: 1 } });
      let failure: unknown;
      try {
        await engine.execute("author", "delete", { where: { id: 99 } });
      } catch (caught) {
        failure = caught;
      }
      assert.ok(failure instanceof NotFoundError, String(failure));
      assert.deepEqual(
        { ...failure.meta },
        { model: "author", operation: "delete" },
        "no series, no progress record"
      );
    } finally {
      await client.$disconnect();
      database.close();
    }
  });
});
