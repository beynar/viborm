/**
 * Rulings unit — D-28, the driver `parseResult` consumer.
 *
 * `DriverResultParser.parseResult?(raw, operation, next)`
 * (`src/drivers/driver-instrumentation.ts`) is a public driver contract: a
 * driver may wrap the raw result of an operation ONCE, before decoding. D-17
 * restored only the row-value half (`parseField`, the adapter/driver chain at
 * the one row boundary); this is the other half, and until it was wired nothing
 * in `src/` called a driver's `parseResult` at all.
 *
 * What this file pins:
 *  1. the middleware sees each operation's raw result EXACTLY ONCE — not per
 *     statement, not per member — with the operation's own verb;
 *  2. the same boundary on the live route and on the prepared/batch route
 *     (rule 7, one decoder for both);
 *  3. `raw` is the provider's own answer, above the row-value chain: a SQLite
 *     boolean arrives as the integer the transport stored and is still
 *     published as a boolean, because `next` chains through the adapter's
 *     `parseResult` into the engine's decoder;
 *  4. `next(transformed)` is honoured — the decoder reads what the middleware
 *     handed it, which is what lets a driver recover a result its own transport
 *     reshaped (no driver the estate ships installs one: Arnaud's D-35 deleted
 *     the SQLite family's count/exists arm, whose fact the engine's decoder
 *     already owned);
 *  5. the CHUNKED terminal: an operation whose terminal read-back is split by
 *     the provider's bind budget is still ONE result — the middleware is asked
 *     once, about the operation's rows, in input order, on the live arm and on
 *     the batch/prepared arm, while each window's own row-count contract is
 *     decided per window (the repair round's F1).
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type {
  DriverResultParser,
  QueryExecutionContext,
  QueryResult,
} from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

const widget = s
  .model({
    id: s.int().id(),
    name: s.string(),
    rank: s.int(),
    active: s.boolean(),
  })
  .map("d28_widgets");

const schema = { widget };

interface Observed {
  readonly operation: string;
  readonly raw: unknown;
}

/** A driver that records every `parseResult` it is asked, and chains. */
class ObservingDriver extends RecordingSQLiteDriver {
  readonly observed: Observed[] = [];
  /** When set, the answer this middleware hands to `next` instead of `raw`. */
  replacement?: unknown;

  override readonly result: DriverResultParser = {
    parseResult: (raw, operation, next) => {
      this.observed.push({ operation, raw });
      return next(this.replacement ?? raw, operation);
    },
    // Left as a pass-through on purpose: the row-value chain BELOW this
    // middleware is D-17's half and already owns scalar meaning.
    parseField: (value, scalarType, next) => next(value, scalarType),
  };
}

/** The same driver, on the transport that PACKAGES an array of operations. */
class ObservingBatchDriver extends ObservingDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

/**
 * The same driver with no RETURNING and a low bind budget, so a `createMany`
 * with `select` publishes through a terminal READ-BACK that the budget splits
 * into windows: four identities cost `3k + 1` parameters for a window of `k`
 * (the key predicate plus the input-order `CASE WHEN`), so a budget of seven
 * answers in two windows of two.
 */
class ObservingChunkedDriver extends ObservingDriver {
  /**
   * The terminal read-back statements the PROVIDER received, one per window.
   * Counted here rather than from `statements`, which also records a batch's
   * composition and would count a batched window twice.
   */
  readonly terminalReads: string[] = [];

  constructor(database: Database.Database) {
    super({ client: database });
    this.adapter.capabilities.supportsReturning = false;
    this.maxBindParametersPerStatement = 7;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (TERMINAL_READS.test(statement)) this.terminalReads.push(statement);
    return super.execute<T>(client, statement, parameters, context);
  }
}

/** The chunked terminal on the batch transport (the prepared arm). */
class ObservingChunkedBatchDriver extends ObservingChunkedDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

interface World {
  readonly driver: ObservingDriver;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

/** The same world whose driver counts the terminal's own windows. */
interface ChunkedWorld extends World {
  readonly driver: ObservingChunkedDriver;
}

function buildClient(driver: ObservingDriver) {
  return createClient({ schema, driver });
}

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function createWorld(batch: boolean): Promise<World> {
  const database = new Database(":memory:");
  const driver = batch
    ? new ObservingBatchDriver({ client: database })
    : new ObservingDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("D-28 world schema did not apply");
  await client.widget.create({
    data: { id: 1, name: "first", rank: 3, active: true },
  });
  await client.widget.create({
    data: { id: 2, name: "second", rank: 5, active: false },
  });
  driver.observed.length = 0;
  return {
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

/** The same world on a transport whose terminal read-back is chunked. */
async function createChunkedWorld(batch: boolean): Promise<ChunkedWorld> {
  const database = new Database(":memory:");
  const driver: ObservingChunkedDriver = batch
    ? new ObservingChunkedBatchDriver(database)
    : new ObservingChunkedDriver(database);
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied)
    throw new Error("D-28 chunked world schema did not apply");
  driver.reset();
  driver.observed.length = 0;
  driver.terminalReads.length = 0;
  return {
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

/** The rows a chunked `createMany` writes: input order is NOT key order. */
const CHUNKED_ROWS = [
  { id: 4, name: "d", rank: 1, active: true },
  { id: 2, name: "b", rank: 2, active: false },
  { id: 3, name: "c", rank: 3, active: true },
  { id: 1, name: "a", rank: 4, active: false },
];

/** The terminal read-back's own statements, as the provider received them. */
const TERMINAL_READS = /^\s*SELECT[\s\S]*"d28_widgets"/i;

describe("D-28 — the driver parseResult middleware is a result consumer", () => {
  it("sees each operation's raw result exactly once on the live route", async () => {
    world = await createWorld(false);
    const client = world.client;

    assert.equal((await client.widget.findMany({})).length, 2);
    assert.equal((await client.widget.findUnique({ where: { id: 1 } }))?.id, 1);
    assert.equal(await client.widget.count({}), 2);
    assert.deepEqual(await client.widget.aggregate({ _sum: { rank: true } }), {
      _sum: { rank: 8 },
    });
    assert.equal(
      (
        await client.widget.create({
          data: { id: 3, name: "third", rank: 7, active: true },
        })
      ).id,
      3
    );
    assert.equal(
      (await client.widget.update({ where: { id: 3 }, data: { rank: 9 } }))
        .rank,
      9
    );

    // One call per OPERATION, in order, each naming its own verb — and never a
    // second call for the statements or members the operation also ran.
    assert.deepEqual(
      world.driver.observed.map(({ operation }) => operation),
      ["findMany", "findUnique", "count", "aggregate", "create", "update"]
    );
  });

  it("sees each operation's raw result exactly once on the prepared route", async () => {
    world = await createWorld(true);
    const client = world.client;

    const answers = await client.$transaction([
      client.widget.findMany({}),
      client.widget.findUnique({ where: { id: 1 } }),
      client.widget.count({}),
      client.widget.aggregate({ _sum: { rank: true } }),
      client.widget.create({
        data: { id: 4, name: "fourth", rank: 1, active: false },
      }),
      client.widget.update({ where: { id: 1 }, data: { rank: 11 } }),
    ]);

    assert.equal((answers[0] as unknown[]).length, 2);
    assert.equal(answers[2], 2);
    assert.deepEqual(
      world.driver.observed.map(({ operation }) => operation),
      ["findMany", "findUnique", "count", "aggregate", "create", "update"]
    );
  });

  it("is asked above parseField, with the provider's own rows", async () => {
    world = await createWorld(false);

    const rows = await world.client.widget.findMany({
      orderBy: { id: "asc" },
    });
    // The public answer is a boolean, decoded by the row-value chain BELOW
    // this middleware...
    assert.deepEqual(
      rows.map((row) => row.active),
      [true, false]
    );
    // ...and what the middleware was handed is what SQLite actually answered:
    // the stored integers, in the provider's own width.
    const [observed] = world.driver.observed;
    assert.ok(Array.isArray(observed?.raw));
    assert.deepEqual(
      (observed.raw as { active: unknown }[]).map((row) => row.active),
      [1n, 0n]
    );
  });

  it("decodes what the middleware hands to next, not what the provider said", async () => {
    world = await createWorld(false);
    world.driver.replacement = [
      { id: 99, name: "substituted", rank: 0, active: 1 },
    ];

    // `next(transformed)` chains through the adapter's own `parseResult` into
    // the engine's decoder, so a middleware that reshapes the provider's answer
    // reshapes the published one — the mechanism a driver outside the estate
    // needs to recover a result its transport reshaped. The SQLite family's own
    // count/exists arm was written against it and is gone (D-35): the alias the
    // engine asks for is the one authority on where a count lives.
    assert.deepEqual(await world.client.widget.findMany({}), [
      { id: 99, name: "substituted", rank: 0, active: true },
    ]);
  });

  it("sees a chunked terminal's rows once, in input order, on both routes", async () => {
    // The terminal a `createMany` with `select` publishes on a provider without
    // RETURNING is ONE projection split by the bind budget (`seriesQueries`).
    // Every window carries the same shape and its OWN row-count contract, so
    // the count is decided per window — while the window is still known — and
    // the middleware is asked once, about the operation's rows. Asking it per
    // window would be "per statement", which the ruling forbids; decoding the
    // concatenation against window 0's contract refuses a legitimate operation
    // (the repair round's F1: three cells of `g3-execution-review` and one of
    // `g3-author-execution-regressions` measured it).
    for (const batch of [false, true]) {
      const chunked = await createChunkedWorld(batch);
      world = chunked;
      const published = await chunked.client.widget.createMany({
        data: CHUNKED_ROWS,
        // The key the read-back addresses is NOT in the public result.
        select: { name: true, rank: true },
      });
      // Several windows, really: the read-back reached the provider twice.
      assert.equal(chunked.driver.terminalReads.length, 2);
      // One ask for the operation, naming the operation's own verb.
      assert.deepEqual(
        chunked.driver.observed.map(({ operation }) => operation),
        ["createMany"]
      );
      // And it is handed the OPERATION's rows — all four, in input order —
      // not one window's two.
      const [observed] = chunked.driver.observed;
      assert.ok(Array.isArray(observed?.raw));
      assert.deepEqual(
        (observed.raw as { name: unknown }[]).map((row) => row.name),
        ["d", "b", "c", "a"]
      );
      // The published cardinality is the input's, whatever the budget was.
      assert.deepEqual(
        published,
        CHUNKED_ROWS.map(({ name, rank }) => ({ name, rank }))
      );
      await chunked.close();
      world = undefined;
    }
  });
});
