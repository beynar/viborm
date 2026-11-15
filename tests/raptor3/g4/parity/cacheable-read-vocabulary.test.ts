/**
 * FC-04 — the cached-result vocabulary boundary, executed (closure inventory
 * row J-13).
 *
 * `codec(run)` refuses a call that publishes no prepared read. WHICH verbs can
 * reach it is decided in another layer: the official cache admits
 * `CACHEABLE_OPERATIONS` (`cache/schema.ts`, nine names, both `…OrThrow`
 * variants among them) while the engine's own `READ_OPERATIONS`
 * (`raptor3/shared/schema.ts`) has seven. No type ties the two lists together;
 * the whole reconciliation is `baseOperation`'s `…OrThrow` normalization
 * (`query-engine/routed-operations.ts`). That missing owner is why the refusal
 * is KEPT rather than asserted away (N4, plan §4) — and it is also why the
 * boundary needs a measurement rather than a source reading.
 *
 * These cells state what it restricts today: every cacheable name is stored
 * and served from the driver rows it read, a hit equal to the executed result
 * (`Date` leaves included) with no statement sent, and the refusal is reached
 * only by a verb the cache layer never offers it — before anything is
 * dispatched. A future divergence between the two vocabularies fails here
 * instead of at a user's cached read, in BOTH directions: the nine names below
 * are a hand copy of a module-private set, so cell 1 checks them against the
 * refusal of a write through the cached view, which publishes the whole of
 * `CACHEABLE` (`cache/schema.ts`). A tenth cacheable verb with no prepared
 * read therefore fails here.
 */

import assert from "node:assert/strict";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  CacheOperationNotCacheableError,
  NotFoundError,
  UnsupportedOperationError,
} from "@errors";
import { around, codec, extension, type Run } from "@extensions/index";
import { hydrateSchemaNames, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import DatabaseConstructor from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    age: s.int(),
    joinedAt: s.dateTime(),
  })
  .map("fc04_cacheable_authors");

const schema = { author };
hydrateSchemaNames(schema);

/** The nine names `CACHEABLE_OPERATIONS` admits, with a payload each. */
const CACHEABLE: readonly (readonly [string, Record<string, unknown>])[] = [
  ["findFirst", { orderBy: { id: "asc" } }],
  ["findMany", { orderBy: { id: "asc" } }],
  ["findUnique", { where: { id: 1 } }],
  ["findUniqueOrThrow", { where: { id: 1 } }],
  ["findFirstOrThrow", { orderBy: { id: "asc" } }],
  ["count", {}],
  [
    "aggregate",
    { _count: true, _avg: { age: true }, _max: { joinedAt: true } },
  ],
  ["groupBy", { by: ["age"], _count: true, orderBy: { age: "asc" } }],
  ["exist", {}],
] as const;

/** Where `CacheOperationNotCacheableError` publishes the gate's whole list. */
const PUBLISHED_VOCABULARY = "Only read operations can be cached: ";

/** Records every statement text the client submits. */
class RecordingSQLiteDriver extends SQLite3Driver {
  readonly sent: string[] = [];
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.sent.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world() {
  const database = new DatabaseConstructor(":memory:");
  const driver = new RecordingSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.createMany({
    data: [
      {
        id: 1,
        name: "Ada",
        age: 36,
        joinedAt: new Date("2020-03-01T10:00:00.000Z"),
      },
      {
        id: 2,
        name: "Bo",
        age: 41,
        joinedAt: new Date("2021-07-04T08:30:00.000Z"),
      },
      {
        id: 3,
        name: "Cy",
        age: 36,
        joinedAt: new Date("2022-11-09T23:59:59.000Z"),
      },
    ],
  });
  const cached = client.$extends(cache({ driver: new MemoryCache() }));
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, driver, cached };
}

/** Lets the background set of a miss land before the next read. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("FC-04 — the cached-result vocabulary boundary", () => {
  it("every cacheable verb is served from the rows it read, equal to its own result", async () => {
    const { client, driver, cached } = await world();
    const model = client.author as unknown as Record<string, CallableFunction>;
    const reader = cached.$withCache() as unknown as {
      author: Record<string, CallableFunction>;
    };
    for (const [operation, args] of CACHEABLE) {
      const value = await model[operation]!({ ...args });
      assert.notEqual(
        value,
        undefined,
        `${operation}: the verb answered nothing to round-trip`
      );
      assert.deepEqual(await reader.author[operation]!({ ...args }), value);
      await settle();
      const sent = driver.sent.length;
      assert.deepEqual(
        await reader.author[operation]!({ ...args }),
        value,
        `${operation}: the cached representation is not the operation's result`
      );
      assert.equal(driver.sent.length, sent, `${operation}: the hit was sent`);
    }
    // The payloads above are not vacuous: each verb answered its own shape.
    assert.equal(await client.author.count({}), 3);
    assert.equal(await client.author.exist({}), true);
    // And the nine are the gate's list, not this file's: a write through the
    // cached view is refused with the whole of `CACHEABLE`, so a TENTH
    // cacheable name — the direction that would crash a user's cached read —
    // fails here too.
    let published: string[] = [];
    await assert.rejects(
      reader.author.create!({
        data: { id: 4, name: "Di", age: 20, joinedAt: new Date(0) },
      }),
      (error: unknown) => {
        if (!(error instanceof CacheOperationNotCacheableError)) {
          return false;
        }
        published = (error.message.split(PUBLISHED_VOCABULARY)[1] ?? "").split(
          ", "
        );
        return true;
      },
      "the cache gate does not refuse a verb that publishes no prepared read"
    );
    assert.deepEqual(
      [...published].sort(),
      CACHEABLE.map(([operation]) => operation).sort(),
      "the cache layer's vocabulary is no longer exactly these nine names"
    );
  });

  it("both …OrThrow names store a found row and never a missing one", async () => {
    const { driver, cached } = await world();
    const reader = cached.$withCache();
    const located = {
      id: 1,
      name: "Ada",
      age: 36,
      joinedAt: new Date("2020-03-01T10:00:00.000Z"),
    };
    const firstOrder = { orderBy: { id: "asc" } } as const;
    for (const read of [
      () => reader.author.findUniqueOrThrow({ where: { id: 1 } }),
      () => reader.author.findFirstOrThrow({ ...firstOrder }),
    ]) {
      assert.deepEqual(await read(), located);
      await settle();
      const sent = driver.sent.length;
      assert.deepEqual(await read(), located);
      assert.equal(driver.sent.length, sent);
    }
    // No row: the base verb's `null` is stored and served, the `…OrThrow`
    // name's refusal is neither.
    for (const read of [
      () => reader.author.findUniqueOrThrow({ where: { id: 9 } }),
      () => reader.author.findFirstOrThrow({ where: { id: 9 } }),
    ]) {
      await assert.rejects(read(), NotFoundError);
      await settle();
      const sent = driver.sent.length;
      await assert.rejects(read(), NotFoundError);
      assert.equal(driver.sent.length, sent + 1);
    }
    assert.equal(await reader.author.findUnique({ where: { id: 9 } }), null);
    await settle();
    const sent = driver.sent.length;
    assert.equal(await reader.author.findUnique({ where: { id: 9 } }), null);
    assert.equal(driver.sent.length, sent);
  });

  it("a verb the cache layer never offers reaches the retained boundary, before anything runs", async () => {
    const { client, driver } = await world();
    const failures: unknown[] = [];
    const detaching = client.$extends(
      extension(
        "detach",
        around(() => <R>(run: Run<unknown, R>): Promise<R> => {
          try {
            codec(run);
          } catch (error) {
            failures.push(error);
            throw error;
          }
          return run();
        })
      )
    );
    driver.sent.length = 0;
    await assert.rejects(
      detaching.author.create({
        data: { id: 9, name: "Dee", age: 20, joinedAt: new Date() },
      }),
      UnsupportedOperationError
    );
    assert.equal(failures.length, 1);
    assert.ok(
      failures[0] instanceof UnsupportedOperationError &&
        failures[0].message === "codec() takes the run of a model's read."
    );
    // The boundary is reached before the write runs: no statement was
    // submitted and no row was created.
    assert.deepEqual(driver.sent, []);
    assert.equal(await client.author.count({}), 3);
  });
});
