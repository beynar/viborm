/**
 * Custom JSON schemas validate and transform writes once. Reads, RETURNING,
 * prepared batches and cached snapshots decode the stored JSON domain without
 * replaying arbitrary user code. This remediation supersedes D-33's older
 * read-time schema contract. Physical scalar failures still raise QueryError.
 *
 * Values are compared with `node:assert/strict`, like the sibling pins: a
 * `json` field's public type is the recursive `JsonValue`, which vitest's
 * structural matchers instantiate to exhaustion (TS2589) once it reaches the
 * expected type.
 */

import assert from "node:assert/strict";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { QueryError, ValidationError } from "@errors";
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
 * Admission publishes `{ n, tag: "d33" }`; every read must return that stored
 * output without invoking this transform again.
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

describe("custom JSON schema admission and physical read parity", () => {
  it("reads the stored write output without replaying the schema", async () => {
    world = await createWorld();
    const client = world.client;

    const many = await client.document.findMany({ orderBy: { id: "asc" } });
    assert.deepEqual(
      world.database
        .prepare("SELECT payload FROM d33_documents WHERE id = 1")
        .get(),
      { payload: JSON.stringify({ n: 1, tag: "d33" }) }
    );
    assert.equal(many.length, 2);
    assert.deepEqual(many[0]?.payload, { n: 1, tag: "d33" });
    assert.deepEqual(many[1]?.payload, { n: 2, tag: "d33" });
    assert.equal(schemaRuns, 0);

    schemaRuns = 0;
    const one = await client.document.findUnique({ where: { id: 1 } });
    assert.deepEqual(one?.payload, { n: 1, tag: "d33" });
    assert.equal(schemaRuns, 0);

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

  it("transforms create once regardless of its RETURNING projection", async () => {
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

    // Selecting the stored JSON output must not transform it a second time.
    schemaRuns = 0;
    assert.deepEqual(
      await client.document.create({
        data: { id: 4, label: "fourth", rank: 4, payload: { n: 4 } },
        select: { payload: true },
      }),
      { payload: { n: 4, tag: "d33" } }
    );
    assert.equal(schemaRuns, 1);
  });

  it("runs only the prepared batch's write admission", async () => {
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
    assert.equal(schemaRuns, 1);
  });

  it("refuses invalid writes but does not reinterpret externally stored JSON", async () => {
    world = await createWorld();
    const client = world.client;
    const invalid = await refusal(() =>
      client.document.create({
        data: { id: 3, label: "invalid", rank: 3, payload: [1, 2, 3] },
      })
    );
    assert.ok(invalid instanceof ValidationError);
    assert.equal(schemaRuns, 1);
    assert.equal(await client.document.count(), 2);

    schemaRuns = 0;
    storeRawColumn(world, 1, "payload", '{"n":"one"}');
    const row = await client.document.findUnique({ where: { id: 1 } });
    assert.deepEqual(row?.payload, { n: "one" });
    assert.equal(schemaRuns, 0);
  });

  it("keeps physical scalar refusal distinct from custom schema admission in arrays", async () => {
    world = await createWorld(true);
    const client = world.client;
    storeRawColumn(world, 2, "payload", "[1,2,3]");
    assert.deepEqual(
      await client.$transaction([
        client.document.findUnique({
          where: { id: 2 },
          select: { payload: true },
        }),
      ]),
      [{ payload: [1, 2, 3] }]
    );
    assert.deepEqual(
      (await client.document.findUnique({ where: { id: 2 } }))?.payload,
      [1, 2, 3]
    );
    assert.equal(schemaRuns, 0);

    storeRawColumn(world, 1, "rank", "not an integer");
    const arrayFailure = await refusal(() =>
      client.$transaction([client.document.findMany({ where: { id: 1 } })])
    );
    const directFailure = await refusal(() =>
      client.document.findMany({ where: { id: 1 } })
    );
    for (const failed of [arrayFailure, directFailure]) {
      assert.ok(
        failed instanceof QueryError,
        `not a QueryError: ${String(failed)}`
      );
      assert.equal(failed.code, "V2006");
      assert.equal(failed.meta?.driver, "sqlite3");
      assert.equal(failed.meta?.model, "document");
      assert.equal(failed.meta?.operation, "findMany");
      assert.equal(failed.meta?.scalarType, "int");
      assert.equal(failed.meta?.reason, "the value is not a canonical integer");
      assert.equal(failed.isRetryable(), false);
    }
  });

  it("refuses an async user schema and handles the promise it discards (D-37)", async () => {
    // Async write schemas refuse admission and their rejected promise must
    // remain handled. Reads of an existing physical document never invoke it.
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
      assert.deepEqual(
        (await client.late.findUnique({ where: { id: 1 } }))?.payload,
        { n: 1 }
      );
      const refused = await refusal(() =>
        client.late.create({ data: { id: 2, payload: { n: 2 } } })
      );
      assert.ok(refused instanceof ValidationError);
      assert.equal(await client.late.count(), 1);
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

    // Cache misses, hits and revalidation decode the stored write output.
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 0);

    // The HIT answers from the snapshot, which holds the DECODED value: the
    // same published document, and the schema is not asked again — the cache
    // route must not run it a second time.
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 0);

    // The stale-while-revalidate read serves the snapshot and revalidates in
    // the background; that revalidation is an ordinary read, so it decodes
    // without replaying the write transform.
    clock.advance(11);
    assert.deepEqual(await cached.document.findMany(read), transformed);
    await settle();
    assert.equal(schemaRuns, 0);
  });
});
