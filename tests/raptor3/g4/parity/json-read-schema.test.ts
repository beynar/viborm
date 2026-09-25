/**
 * Rulings unit — D-33, a `json().schema(…)` field's user schema on the READ path.
 *
 * `s.json().schema(standardSchema)` declares a Standard Schema the caller wrote.
 * The engine replaced ran it at its one decode boundary — `ResultParser.ts:721`
 * read the fact once per compiled field chain and handed it to the JSON codec's
 * parse (`scalar-structured-parser.ts:78` `parseJsonValueWithSchema`) — so the
 * value a read published was the SCHEMA's output, and a stored document the
 * schema refused was a malformed provider value. After the cutover the write
 * path still ran it at admission and no read path consulted it at all
 * (`g4/parity/integration-note.md` §1c: `validate` invoked zero times).
 *
 * What this file pins (Arnaud's D-33; the accepted cost is one schema run per
 * JSON field per row read):
 *  1. a transforming schema's OUTPUT is what `findMany`, `findUnique` and
 *     `create … select` publish — on the live route and on the prepared/batch
 *     route, which decode through the same `compileReader`/`decodeScalar` owner;
 *  2. the schema runs EXACTLY ONCE per decoded value — never twice for one
 *     value, and never at all for a field the projection did not select;
 *  3. a stored document the schema REFUSES raises the restored public
 *     `QueryEngineError` sentence, redacted: the schema's own issue text
 *     describes a stored document and never reaches the caller;
 *  4. the cache route materializes the transformed value from its snapshot
 *     WITHOUT a second schema run, and a revalidation decodes once more —
 *     one decoder for the live, the prepared, the batch and the cached read.
 *
 * Values are compared with `node:assert/strict`, like the sibling pins: a
 * `json` field's public type is the recursive `JsonValue`, which vitest's
 * structural matchers instantiate to exhaustion (TS2589) once it reaches the
 * expected type.
 */

import assert from "node:assert/strict";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { QueryEngineError, QueryError } from "@errors";
import { s } from "@schema";
import type { JsonValue } from "@src/validation";
import { isRecord } from "@src/validation/value-guards";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { ClockedMemoryCache } from "@tests/fixtures/clocked-memory-cache";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createTestClock } from "@tests/fixtures/test-clock";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { RecordingSQLiteDriver } from "../unit02/world";

/** Every invocation of the field's own schema, wherever it happens. */
let schemaRuns = 0;

/** What the field's schema publishes: a concrete document, not `JsonValue`. */
type TaggedDocument = { n: number; tag: string };

/**
 * A TRANSFORMING schema, and an IDEMPOTENT one: `{ n }` becomes
 * `{ n, tag: "d33" }`, and tagging an already tagged document changes nothing.
 * That is what lets one document cross admission — where the write path runs
 * this same schema — and come back through the read boundary without the two
 * runs disagreeing about what is stored.
 */
const tagged: StandardSchemaV1<JsonValue, TaggedDocument> = {
  "~standard": {
    version: 1,
    vendor: "raptor3-d33",
    validate(value) {
      schemaRuns += 1;
      if (!isRecord(value)) {
        return { issues: [{ message: "d33: not a document" }] };
      }
      const n = value.n;
      if (typeof n !== "number") {
        return { issues: [{ message: `d33: n is ${typeof n}` }] };
      }
      return { value: { n, tag: "d33" } };
    },
  },
};

const document = s
  .model({
    id: s.int().id(),
    label: s.string(),
    rank: s.int(),
    payload: s.json().schema(tagged),
  })
  .map("d33_documents");

const schema = { document };

function buildClient(driver: RecordingSQLiteDriver) {
  return createClient({ schema, driver });
}

interface World {
  readonly database: Database.Database;
  readonly driver: RecordingSQLiteDriver;
  readonly client: ReturnType<typeof buildClient>;
  close(): Promise<void>;
}

/** The same transport, packaging an array of operations instead of a region. */
class BatchOnlySQLiteDriver extends RecordingSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

let world: World | undefined;

afterEach(async () => {
  await world?.close();
  world = undefined;
  schemaRuns = 0;
});

async function createWorld(batch = false): Promise<World> {
  const database = new Database(":memory:");
  const driver = batch
    ? new BatchOnlySQLiteDriver({ client: database })
    : new RecordingSQLiteDriver({ client: database });
  const client = buildClient(driver);
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("D-33 world schema did not apply");
  await client.document.create({
    data: { id: 1, label: "first", rank: 1, payload: { n: 1 } },
  });
  await client.document.create({
    data: { id: 2, label: "second", rank: 2, payload: { n: 2 } },
  });
  schemaRuns = 0;
  return {
    database,
    driver,
    client,
    async close() {
      await client.$disconnect();
      database.close();
    },
  };
}

/** Store a value the estate would never admit, behind the write path's back. */
function storeRawColumn(
  open: { readonly database: Database.Database },
  id: number,
  column: "payload" | "rank",
  value: string
): void {
  open.database
    .prepare(`UPDATE d33_documents SET ${column} = ? WHERE id = ?`)
    .run(value, id);
}

/** The failure of one call, without unwrapping it. */
async function refusal(run: () => PromiseLike<unknown>): Promise<unknown> {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe("D-33 — a json().schema(…) field's schema runs at the decode boundary", () => {
  it("publishes the schema's output on the live route, once per value", async () => {
    world = await createWorld();
    const client = world.client;

    const many = await client.document.findMany({ orderBy: { id: "asc" } });
    // The schema is the only thing that can have produced `tag`...
    assert.equal(many.length, 2);
    assert.deepEqual(many[0]?.payload, { n: 1, tag: "d33" });
    assert.deepEqual(many[1]?.payload, { n: 2, tag: "d33" });
    // ...and two rows read are two runs: once per decoded VALUE.
    assert.equal(schemaRuns, 2);

    schemaRuns = 0;
    const one = await client.document.findUnique({ where: { id: 1 } });
    assert.deepEqual(one?.payload, { n: 1, tag: "d33" });
    assert.equal(schemaRuns, 1);

    // A field the projection did not select is not decoded, so its schema is
    // not asked: the fact travels on the prepared projection's own leaf, not
    // on a second walker looking for JSON columns.
    schemaRuns = 0;
    assert.deepEqual(
      await client.document.findMany({ select: { label: true } }),
      [{ label: "first" }, { label: "second" }]
    );
    assert.equal(schemaRuns, 0);
  });

  it("publishes the schema's output for a create's RETURNING row", async () => {
    world = await createWorld();
    const client = world.client;

    // Admission runs it once — the write path always did — and selecting no
    // JSON field decodes none, so that is the only run.
    assert.deepEqual(
      await client.document.create({
        data: { id: 3, label: "third", rank: 3, payload: { n: 3 } },
        select: { id: true },
      }),
      { id: 3 }
    );
    assert.equal(schemaRuns, 1);

    // The same create with the JSON field selected: admission once, and the
    // decode boundary exactly once more.
    schemaRuns = 0;
    assert.deepEqual(
      await client.document.create({
        data: { id: 4, label: "fourth", rank: 4, payload: { n: 4 } },
        select: { payload: true },
      }),
      { payload: { n: 4, tag: "d33" } }
    );
    assert.equal(schemaRuns, 2);
  });

  it("publishes the schema's output on the prepared route, once per value", async () => {
    world = await createWorld(true);
    const client = world.client;

    const answers = await client.$transaction([
      client.document.findMany({ orderBy: { id: "asc" } }),
      client.document.findUnique({ where: { id: 2 } }),
      client.document.create({
        data: { id: 5, label: "fifth", rank: 5, payload: { n: 5 } },
        select: { payload: true },
      }),
    ]);

    assert.deepEqual(
      (answers[0] as { payload: unknown }[]).map((row) => row.payload),
      [
        { n: 1, tag: "d33" },
        { n: 2, tag: "d33" },
      ]
    );
    assert.deepEqual((answers[1] as { payload: unknown } | null)?.payload, {
      n: 2,
      tag: "d33",
    });
    assert.deepEqual(answers[2], { payload: { n: 5, tag: "d33" } });
    // Two rows, one row and one created row decoded, plus the create's own
    // admission run: the prepared route asks exactly as often as the live one.
    assert.equal(schemaRuns, 5);
  });

  it("refuses a stored document the schema rejects, with the restored sentence", async () => {
    world = await createWorld();
    const client = world.client;
    storeRawColumn(world, 1, "payload", '{"n":"one"}');

    const refused = await refusal(() =>
      client.document.findUnique({ where: { id: 1 } })
    );

    assert.ok(
      refused instanceof QueryEngineError,
      `not a QueryEngineError: ${String(refused)}`
    );
    assert.equal(
      refused.message,
      'Driver "sqlite3" returned a malformed json scalar for operation "findUnique": custom output schema rejected the value.'
    );
    assert.equal(refused.meta?.driver, "sqlite3");
    assert.equal(refused.meta?.operation, "findUnique");
    assert.equal(refused.meta?.scalarType, "json");
    // Redacted: the schema's own issue text is about a STORED document and is
    // not the caller's to read.
    assert.equal(refused.message.includes("d33: n is"), false);
  });

  it("refuses one inside an array transaction the way that route refuses the decoder's other malformed values", async () => {
    world = await createWorld(true);
    const client = world.client;
    storeRawColumn(world, 2, "payload", "[1,2,3]");
    storeRawColumn(world, 1, "rank", "not an integer");

    const refused = async (id: number) =>
      await refusal(() =>
        client.$transaction([client.document.findMany({ where: { id } })])
      );
    // The schema's refusal of a stored document...
    const schemaRefusal = await refused(2);
    // ...and a refusal this decoder already owned before the ruling, on an
    // `int` column, with no user schema anywhere near it.
    const intRefusal = await refused(1);

    // An array transaction normalises whatever escapes its own execution scope
    // (`drivers/error-mapping.ts:384`), so on THAT route both are the same
    // public failure. That shape is the array route's, not this ruling's: the
    // two are indistinguishable, and neither is a raw `Error`.
    for (const failure of [schemaRefusal, intRefusal]) {
      assert.ok(
        failure instanceof QueryError,
        `not a QueryError: ${String(failure)}`
      );
      assert.equal(failure.message, "Query execution failed");
    }
    assert.equal(
      (schemaRefusal as QueryError).message.includes("d33: n is"),
      false
    );

    // The same refused document on the same batch-capable transport, asked as
    // ONE operation instead of an array member, publishes the restored
    // sentence: what the array route changes is its own normalisation, and the
    // schema's refusal is this decoder's refusal on every route.
    const direct = await refusal(() =>
      client.document.findMany({ where: { id: 2 } })
    );
    assert.ok(
      direct instanceof QueryEngineError,
      `not a QueryEngineError: ${String(direct)}`
    );
    assert.equal(
      direct.message,
      'Driver "sqlite3" returned a malformed json scalar for operation "findMany": custom output schema rejected the value.'
    );
  });

  it("refuses an async user schema and handles the promise it discards (D-37)", async () => {
    // An async schema is unsupported on the read path exactly as at admission:
    // `parse` refuses it unread. The promise it returned is still live, and
    // before D-37 its rejection surfaced as an unhandled rejection — a
    // process-level fault for a schema the caller was already told is
    // unsupported. The deleted codec attached the handler; `parse` now does.
    const asyncSchema: StandardSchemaV1<JsonValue, JsonValue> = {
      "~standard": {
        version: 1,
        vendor: "raptor3-d37",
        validate: () => Promise.reject(new Error("d37: late rejection")),
      },
    };
    const late = s
      .model({ id: s.int().id(), payload: s.json().schema(asyncSchema) })
      .map("d37_late");
    const database = new Database(":memory:");
    const driver = new RecordingSQLiteDriver({ client: database });
    const client = createClient({ schema: { late }, driver });
    const migration = await syncLiveSchema(client);
    if (!migration.applied) throw new Error("D-37 world schema did not apply");
    // Admission refuses the async schema too, so the row is stored raw.
    database
      .prepare("INSERT INTO d37_late (id, payload) VALUES (?, ?)")
      .run(1, '{"n":1}');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const refused = await refusal(() =>
        client.late.findUnique({ where: { id: 1 } })
      );
      assert.ok(
        refused instanceof QueryEngineError,
        `not a QueryEngineError: ${String(refused)}`
      );
      assert.equal(
        refused.message,
        'Driver "sqlite3" returned a malformed json scalar for operation "findUnique": custom output schema rejected the value.'
      );
      // Node reports an unhandled rejection only after the microtask queue
      // drains; two macrotask turns are more than it needs.
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off("unhandledRejection", onUnhandled);
      await client.$disconnect();
      database.close();
    }
  });

  it("materializes a cached read from its snapshot without a second run", async () => {
    const database = new Database(":memory:");
    const driver = new RecordingSQLiteDriver({ client: database });
    const clock = createTestClock();
    const backend = new ClockedMemoryCache(clock);
    const background: Promise<unknown>[] = [];
    const base = buildClient(driver);
    const client = base.$extends(
      cacheExtension({
        driver: backend,
        waitUntil: (promise) => {
          background.push(promise);
        },
      })
    );
    const settle = async () => {
      while (background.length > 0) await background.shift();
    };
    world = {
      database,
      driver,
      client: base,
      async close() {
        await base.$disconnect();
        database.close();
      },
    };
    const migration = await syncLiveSchema(client);
    if (!migration.applied) throw new Error("D-33 cache schema did not apply");
    await client.document.create({
      data: { id: 1, label: "first", rank: 1, payload: { n: 1 } },
    });
    schemaRuns = 0;

    const cached = client.$withCache({ ttl: 10, swr: 100 });
    const read = { select: { id: true, payload: true } } as const;
    const transformed = [{ id: 1, payload: { n: 1, tag: "d33" } }];

    // The miss decodes: one run for the one row.
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 1);

    // The HIT answers from the snapshot, which holds the DECODED value: the
    // same published document, and the schema is not asked again — the cache
    // route must not run it a second time.
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 1);

    // The stale-while-revalidate read serves the snapshot and revalidates in
    // the background; that revalidation is an ordinary read, so it decodes
    // exactly once more.
    clock.advance(11);
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 2);
  });
});
