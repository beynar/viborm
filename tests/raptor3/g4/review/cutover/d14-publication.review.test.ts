/**
 * C-01 cutover round-3 review probes (independent reviewer, not a registered mode).
 *
 * D-14 makes `PendingOperation.buildStatement()` / `QueryEngine.build()` publish the
 * ONE statement an operation compiles to, and gives a `QueryEngine` built without a
 * client lineage a route of its own. These cells attack the three claims the note
 * makes about that change:
 *
 *   1. ONE OWNER, NO SECOND LOWERING — the `Sql` `buildStatement()` publishes is the
 *      very object the execution submits (identity, not equality), and asking for it
 *      does not add a round trip.
 *   2. THE REFUSALS ARE THE PRE-CUTOVER ONES — a write still answers
 *      "does not compile to one SQL statement", an unknown verb still answers
 *      "Unknown operation '…'", and a registry without schemas still answers
 *      "Schema registry is required for query engine" rather than a TypeError from
 *      inside the provisioned route.
 *   3. ONE PACKAGE FOR BOTH ARRAY ARMS — `prepareSingle()` publishes exactly what
 *      `prepareBatch()` publishes for a read, and the array member's statement is
 *      the statement the same operation builds.
 *
 * Cell 9 is evidence for a review finding rather than a claim of the unit's: the
 * three non-carrier arms of the cell C-01 deleted from
 * `tests/contracts/engine/query/operation-program-read-contracts.core.test.ts`
 * (`take: -2` reversal, `findFirst`, a missing `findUnique`) still hold on the
 * direct runtime path, so they did not have to die with the shipped result keys.
 */
import assert from "node:assert/strict";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type BatchQuery, type Dialect, Driver } from "@drivers";
import type { QueryResult } from "@drivers/types";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  createModelRegistry,
  QueryEngine,
} from "@query-engine/query-engine";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { hydrateSchemaNames, s } from "@schema";
import type { Sql } from "@sql";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { createSchemaRegistry } from "@validation";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    age: s.int().nullable(),
  })
  .map("g4rc3_authors");
const schema = { author };
hydrateSchemaNames(schema);

/** A driver that answers rows from memory and records every statement object. */
class ProbeDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter = new SQLiteAdapter();
  rows: unknown[] = [];
  readonly submitted: unknown[] = [];
  executions = 0;
  transactions = 0;

  constructor(dialect: Dialect = "sqlite") {
    super(dialect, "g4rc3-probe");
  }
  protected async initClient(): Promise<null> {
    return null;
  }
  protected async closeClient(): Promise<void> {
    // No provider resource is held by a lowering probe.
  }
  protected async execute<T>(
    _client: null,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.executions += 1;
    this.submitted.push({ statement, parameters });
    return { rows: this.rows as T[], rowCount: this.rows.length };
  }
  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return { rows: [], rowCount: 0 };
  }
  protected async transaction<T>(
    _client: null,
    run: (transaction: null) => Promise<T>
  ): Promise<T> {
    this.transactions += 1;
    return run(null);
  }
}

/** Records the statement text of everything the client submits, any transport. */
class IdentityDriver extends SQLite3Driver {
  override readonly supportsBatch = true;
  readonly sent: string[] = [];

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[]
  ): Promise<QueryResult<T>> {
    this.sent.push(statement);
    return super.execute<T>(client, statement, parameters);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    for (const query of queries) this.sent.push(query.sql);
    return super.executeBatch<T>(client, queries);
  }
}

const opened: Database.Database[] = [];
const clients: { $disconnect(): Promise<unknown> }[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
  for (const database of opened.splice(0)) database.close();
});

function bareEngine(driver: Driver<never, never> | ProbeDriver): QueryEngine {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(driver as never, registry);
}

async function liveWorld() {
  const database = new Database(":memory:");
  opened.push(database);
  const driver = new IdentityDriver({ client: database });
  const client = createClient({ driver, schema });
  clients.push(client as unknown as { $disconnect(): Promise<unknown> });
  assert.equal((await syncLiveSchema(client)).applied, true);
  await client.author.create({
    data: { email: "present@example.test", name: "Ada", age: 41 },
  });
  driver.sent.length = 0;
  return { client, driver };
}

describe("C-01 round 3 — the statement the engine publishes is the one it runs", () => {
  it("publishes the SAME Sql object the execution submits, with no extra round trip", async () => {
    const driver = new ProbeDriver();
    const engine = bareEngine(driver);
    const pending = engine.prepare(author, "findMany", {
      where: { name: "Ada" },
      select: { id: true },
    });
    const published = pending.buildStatement();
    assert.ok(published, "a read must publish one statement");
    driver.rows = [{ id: 1 }];
    const rows = await pending;
    assert.deepEqual(rows, [{ id: 1 }]);
    assert.equal(driver.executions, 1);
    assert.equal(driver.transactions, 0);
    // Identity, not equality: a second lowering would produce an equal but
    // distinct Sql.
    assert.equal(pending.buildStatement(), published);
    const submitted = driver.submitted[0] as { statement: string };
    assert.equal(submitted.statement, published.toStatement("?"));
  });

  it("answers the same statement through QueryEngine.build, for every read verb", () => {
    const engine = bareEngine(new ProbeDriver());
    for (const [operation, args] of [
      ["findMany", { where: { name: "Ada" } }],
      ["findFirst", {}],
      ["findUnique", { where: { email: "present@example.test" } }],
      ["count", {}],
      ["exist", {}],
      ["aggregate", { _count: true }],
      ["groupBy", { by: ["name"], _count: true }],
    ] as [string, Record<string, unknown>][]) {
      const statement = engine.build(author, operation as never, args);
      assert.match(statement.toStatement("?"), /^SELECT /, operation);
    }
    // An OrThrow read publishes its statement without reaching a provider.
    const orThrow = engine
      .prepare(author, "findUniqueOrThrow" as never, {
        where: { email: "absent@example.test" },
      })
      .buildStatement();
    assert.ok(orThrow, "findUniqueOrThrow must publish one statement");
  });

  it("refuses every write with the pre-cutover sentence, on both accessors", () => {
    const engine = bareEngine(new ProbeDriver());
    for (const [operation, args] of [
      ["create", { data: { email: "a@b.test", name: "A" } }],
      ["update", { where: { id: 1 }, data: { name: "B" } }],
      ["delete", { where: { id: 1 } }],
      ["upsert", {
        where: { id: 1 },
        create: { email: "a@b.test", name: "A" },
        update: { name: "B" },
      }],
      ["createMany", { data: [{ email: "a@b.test", name: "A" }] }],
      ["updateMany", { where: {}, data: { name: "B" } }],
      ["deleteMany", { where: {} }],
    ] as [string, Record<string, unknown>][]) {
      assert.equal(
        engine.prepare(author, operation as never, args).buildStatement(),
        undefined,
        operation
      );
      assert.throws(
        () => engine.build(author, operation as never, args),
        (error: Error) =>
          error.message ===
          `Operation '${operation}' does not compile to one SQL statement. Execute the operation instead.`,
        operation
      );
    }
  });

  it("keeps the registered refusals around the publication", () => {
    const engine = bareEngine(new ProbeDriver());
    // A removed verb name is still named, from the one vocabulary owner.
    assert.throws(
      () =>
        engine
          .prepare(author, "createManyAndReturn" as never, { data: [] })
          .buildStatement(),
      /Unknown operation 'createManyAndReturn' on model 'author'\. Known operations: aggregate, count, create, createMany, delete, deleteMany, exist, findFirst, findFirstOrThrow, findMany, findUnique, findUniqueOrThrow, groupBy, update, updateMany, upsert\./
    );
    // A malformed payload is refused by admission, at the accessor.
    assert.throws(() =>
      engine.build(author, "findMany" as never, { where: { nope: 1 } })
    );
    // A registry without schemas keeps the engine's own refusal rather than
    // failing inside the provisioned route.
    assert.throws(
      () =>
        new QueryEngine(new ProbeDriver() as never, {
          get: () => undefined,
          getByTableName: () => undefined,
        } as never),
      /Schema registry is required for query engine/
    );
  });

  it("prepareSingle publishes exactly what prepareBatch publishes, for a read", async () => {
    const driver = new ProbeDriver();
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    const route = createCandidateRoute(schema, driver as never, {
      index: registry.relations,
      registry: registry.schemas,
    });
    const args = { where: { name: "Ada" }, select: { id: true, age: true } };
    const single = route
      .operation(author, "findMany", args)
      .prepareSingle(undefined as never);
    const batch = await route
      .operation(author, "findMany", args)
      .prepareBatch(undefined as never);
    assert.ok(single && batch);
    assert.equal(single.queries.length, 1);
    assert.equal(batch.queries.length, 1);
    assert.equal(single.queries[0]?.sql, batch.queries[0]?.sql);
    assert.deepEqual(single.queries[0]?.params, batch.queries[0]?.params);
    const rows = [{ id: 1, age: 41 }];
    assert.deepEqual(
      single.parseResult([{ rows, rowCount: 1 }]),
      batch.parseResult([{ rows, rowCount: 1 }])
    );
    // And it is the statement the same operation publishes to `build()`.
    assert.equal(
      single.queries[0]?.sql,
      route.operation(author, "findMany", args).buildStatement()?.toStatement("?")
    );
    // A write publishes no single package at all.
    assert.equal(
      route
        .operation(author, "create", { data: { email: "a@b.test", name: "A" } })
        .prepareSingle(undefined as never),
      undefined
    );
  });

  it("an array $transaction member runs the statement the same read builds", async () => {
    const { client, driver } = await liveWorld();
    const args = { where: { name: "Ada" }, select: { id: true } };
    const built = (
      client as unknown as {
        $transaction(members: readonly PromiseLike<unknown>[]): Promise<
          unknown[]
        >;
      }
    );
    const results = await built.$transaction([
      client.author.findMany(args),
      client.author.count({}),
    ]);
    assert.deepEqual(results[0], [{ id: 1 }]);
    assert.equal(results[1], 1);
    const texts = driver.sent;
    const reads = texts.filter((text) => text.startsWith("SELECT"));
    assert.equal(reads.length, 2, JSON.stringify(texts));
    const direct = bareEngine(new ProbeDriver())
      .build(author, "findMany", args)
      .toStatement("?");
    assert.equal(reads[0], direct);
  });

  it("refuses a malformed array member before anything is dispatched", async () => {
    const { client, driver } = await liveWorld();
    const array = client as unknown as {
      $transaction(members: readonly PromiseLike<unknown>[]): Promise<
        unknown[]
      >;
    };
    let raised: unknown;
    try {
      await array.$transaction([
        client.author.findMany({ where: { nope: 1 } } as never),
      ]);
    } catch (error) {
      raised = error;
    }
    assert.ok(raised, "a malformed member must refuse");
    assert.equal(
      driver.sent.filter((text) => text.startsWith("SELECT")).length,
      0
    );
  });

  it("the provisioned route reaches every model of a bare engine, .map() names included", async () => {
    const driver = new ProbeDriver();
    const engine = bareEngine(driver);
    driver.rows = [{ id: 7 }];
    const rows = await engine.prepare(author, "findMany", {
      select: { id: true },
    });
    assert.deepEqual(rows, [{ id: 7 }]);
    const submitted = driver.submitted[0] as { statement: string };
    assert.match(submitted.statement, /"g4rc3_authors"/);
    // `bind()` forwards the one route rather than provisioning a second.
    const bound = engine.bind(driver as never);
    assert.equal(bound.route, engine.route);
  });

  it("the deleted direct-runtime arms that carry no shipped result key still hold", async () => {
    const driver = new ProbeDriver();
    const engine = bareEngine(driver);
    driver.rows = [
      { id: 1, name: "Arnaud", email: "a@b.test", age: null },
      { id: 2, name: "Albert", email: "c@d.test", age: null },
    ];
    assert.deepEqual(await engine.prepare(author, "findMany", { take: -2 }), [
      ...driver.rows,
    ].reverse());
    driver.rows = [{ id: 1, name: "Arnaud", email: "a@b.test", age: null }];
    assert.deepEqual(
      await engine.prepare(author, "findFirst", {}),
      driver.rows[0]
    );
    driver.rows = [];
    assert.equal(
      await engine.prepare(author, "findUnique", { where: { id: 404 } }),
      null
    );
    assert.equal(driver.transactions, 0);
  });
});
