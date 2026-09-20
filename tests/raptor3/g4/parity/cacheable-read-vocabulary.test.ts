/**
 * FC-04 — the route's cached-result vocabulary boundary, executed (closure
 * inventory row J-13).
 *
 * `RoutedCandidateOperation.cacheResultCodec()` refuses a verb that publishes
 * no prepared read. WHICH verbs can reach it is decided in another layer: the
 * official cache admits `CACHEABLE_OPERATIONS` (`query-engine/cache-flow.ts`,
 * nine names, both `…OrThrow` variants among them) while the engine's own
 * `READ_OPERATIONS` (`raptor3/shared/schema.ts`) has seven. No type ties the
 * two lists together and no single upstream owner states the fact; the whole
 * reconciliation is `admittedOperation`'s `…OrThrow` normalization
 * (`commands/index.ts`). That missing owner is why the refusal is KEPT rather
 * than asserted away (N4, plan §4) — and it is also why the boundary needs a
 * measurement rather than a source reading.
 *
 * These cells state what it restricts today: every cacheable name publishes a
 * codec, that codec round-trips the operation's OWN executed result (`Date`
 * leaves included, so a structural snapshot that lost the leaf codecs would
 * fail here), and the refusal is reached only by a verb the cache layer never
 * offers it — reached before anything is admitted or dispatched. A future
 * divergence between the two vocabularies fails here instead of at a user's
 * cached read, in BOTH directions: the nine names below are a hand copy of a
 * module-private set, so cell 1 checks them against `validateCacheableOperation`
 * — the exported gate that owns `CACHEABLE_OPERATIONS` and publishes its whole
 * list when it refuses. A tenth cacheable verb with no prepared read therefore
 * fails here, not only a read this engine stopped publishing.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  CacheOperationNotCacheableError,
  UnsupportedOperationError,
} from "@errors";
import { validateCacheableOperation } from "@query-engine/cache-flow";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
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
  const route = createCandidateRoute(schema, driver);
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, driver, route };
}

describe("FC-04 — the route's cached-result vocabulary boundary", () => {
  it("every cacheable verb publishes a codec that round-trips its own result", async () => {
    const { client, route } = await world();
    const model = client.author as unknown as Record<string, CallableFunction>;
    for (const [operation, args] of CACHEABLE) {
      // The cache layer really offers this name: its own gate admits it.
      assert.doesNotThrow(
        () => validateCacheableOperation(operation),
        `${operation}: the cache layer no longer offers this verb`
      );
      const codec = route
        .operation(author as never, operation, { ...args })
        .cacheResultCodec();
      const value = await model[operation]!({ ...args });
      assert.notEqual(
        value,
        undefined,
        `${operation}: the verb answered nothing to round-trip`
      );
      assert.deepEqual(
        codec.materialize(codec.snapshot(value)),
        value,
        `${operation}: the cached representation is not the operation's result`
      );
    }
    // The payloads above are not vacuous: each verb answered its own shape.
    assert.equal(await client.author.count({}), 3);
    assert.equal(await client.author.exist({}), true);
    // And the nine are the gate's list, not this file's: the refusal publishes
    // the whole of `CACHEABLE_OPERATIONS`, so a TENTH cacheable name — the
    // direction that would crash a user's cached read — fails here too.
    let published: string[] = [];
    assert.throws(
      () => validateCacheableOperation("create"),
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

  it("both …OrThrow names are served by the read their base verb admits to", async () => {
    const { client, route } = await world();
    const codec = route
      .operation(author as never, "findUniqueOrThrow", { where: { id: 1 } })
      .cacheResultCodec();
    const located = await client.author.findUniqueOrThrow({ where: { id: 1 } });
    assert.deepEqual(located, {
      id: 1,
      name: "Ada",
      age: 36,
      joinedAt: new Date("2020-03-01T10:00:00.000Z"),
    });
    assert.deepEqual(codec.materialize(codec.snapshot(located)), located);
    // The base read is `findUnique`, whose own publication for zero rows is
    // `null`; the `…OrThrow` name inherits that codec, absent arm included.
    assert.equal(codec.materialize(codec.snapshot(null)), null);
    const base = route
      .operation(author as never, "findUnique", { where: { id: 1 } })
      .cacheResultCodec();
    assert.deepEqual(base.snapshot(located), codec.snapshot(located));

    // The second place the two vocabularies differ, mirrored: `findFirstOrThrow`
    // against the `findFirst` its base verb admits to, absent arm included.
    const firstOrder = { orderBy: { id: "asc" } } as const;
    const firstCodec = route
      .operation(author as never, "findFirstOrThrow", { ...firstOrder })
      .cacheResultCodec();
    const first = await client.author.findFirstOrThrow({ ...firstOrder });
    assert.deepEqual(first, {
      id: 1,
      name: "Ada",
      age: 36,
      joinedAt: new Date("2020-03-01T10:00:00.000Z"),
    });
    assert.deepEqual(firstCodec.materialize(firstCodec.snapshot(first)), first);
    assert.equal(firstCodec.materialize(firstCodec.snapshot(null)), null);
    const firstBase = route
      .operation(author as never, "findFirst", { ...firstOrder })
      .cacheResultCodec();
    assert.deepEqual(firstBase.snapshot(first), firstCodec.snapshot(first));
  });

  it("a verb the cache layer never offers reaches the retained boundary, before anything runs", async () => {
    const { driver, route } = await world();
    driver.sent.length = 0;
    const operation = route.operation(author as never, "create", {
      data: { id: 9, name: "Dee", age: 20, joinedAt: new Date() },
    });
    assert.throws(
      () => operation.cacheResultCodec(),
      (error: unknown) =>
        error instanceof UnsupportedOperationError &&
        error.message ===
          "The Raptor 3 route cannot encode a cached result for 'create' on model 'author': the verb publishes no prepared read."
    );
    // The boundary is reached at publication, not after a write: no statement
    // was submitted and no row was created.
    assert.deepEqual(driver.sent, []);
  });
});
