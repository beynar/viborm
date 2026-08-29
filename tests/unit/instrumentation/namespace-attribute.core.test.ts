// biome-ignore-all lint/suspicious/noMisplacedAssertion: `expectNamespace` is invoked only from test cases.
/**
 * `db.namespace` on every span that carries `db.*`.
 *
 * OpenTelemetry defines the attribute as the database plus schema and allows a
 * reporter to give the component it actually has. VibORM has exactly one: the
 * adapter's configured qualifier — a PostgreSQL schema, a MySQL database, a
 * requested Vitess keyspace — known from configuration, never asked of a
 * provider and never guessed from a connection string.
 *
 * Two shapes are pinned here, and the second is the one that matters. When the
 * adapter is unqualified (SQLite, unbound MySQL/PlanetScale) the KEY IS ABSENT.
 * Not `null`, not `""`, not the text `undefined`: a placeholder would be
 * indistinguishable from a schema actually spelled that way, and would make a
 * dashboard group unrelated databases together while claiming to know which.
 *
 * The five lifecycle kinds are `operation`, `statement`, `segment`, `cache`,
 * and `driver-lifecycle`. Four of them carry `db.*` and are asserted below;
 * `segment` carries only `viborm.write.*`, and its absence of the attribute is
 * pinned too so a later reader does not mistake it for an omission — over a
 * REAL progressive record series, not over a window that happened to open no
 * segment span.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { MemoryCache } from "@cache/drivers/memory";
import { cache as cacheExtension } from "@cache/extension";
import { createClient } from "@client/client";
import { Driver } from "@drivers/driver";
import { PGliteDriver } from "@drivers/pglite";
import type { QueryResult } from "@drivers/types";
import { PGlite } from "@electric-sql/pglite";
import {
  ATTR_DB_NAMESPACE,
  ATTR_DB_SYSTEM,
  ATTR_VIBORM_WRITE_ATOMICITY,
  SPAN_CACHE_GET,
  SPAN_CONNECT,
  SPAN_EXECUTE,
  SPAN_OPERATION,
  SPAN_RECORD_SERIES_SEGMENT,
  SPAN_TRANSACTION,
} from "@instrumentation/spans";
import { s } from "@schema";
import { instrumentation } from "@src/instrumentation/exports";
import { ClockedMemoryCache } from "@tests/fixtures/clocked-memory-cache";
import { createTestClock } from "@tests/fixtures/test-clock";
import {
  type OtelRecorder,
  withOtelRecorder,
} from "@tests/unit/instrumentation/_capture";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const account = s.model({ id: s.string().id(), label: s.string() });
const schema = { account };

/**
 * A relation-bearing bulk write, which routes to a RECORD SERIES. On a
 * batch-only substrate the series runs as progressive segments, and each segment
 * opens the one span kind that carries no `db.*` at all.
 */
const seriesAccount = s
  .model({
    id: s.string().id(),
    label: s.string(),
    notes: s.toMany(() => seriesNote),
  })
  .map("ns_series_accounts");
const seriesNote = s
  .model({
    id: s.string().id(),
    body: s.string(),
    seriesAccountId: s.string(),
    account: s
      .toOne(() => seriesAccount)
      .fields("seriesAccountId")
      .references("id"),
  })
  .map("ns_series_notes");
const seriesSchema = { seriesAccount, seriesNote };

/** A driver whose only variable is the adapter it carries. */
class NamespaceDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter;

  constructor(
    dialect: "postgresql" | "mysql" | "sqlite",
    adapter: DatabaseAdapter
  ) {
    super(dialect, `namespace-attribute-${dialect}`);
    this.adapter = adapter;
  }

  protected initClient(): Promise<object> {
    return Promise.resolve({});
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    const rows: unknown[] = [{ id: "a1", label: "one" }];
    return Promise.resolve({
      rows: rows as T[],
      rowCount: rows.length,
    });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    client: object,
    callback: (transaction: object) => Promise<T>
  ): Promise<T> {
    return callback(client);
  }
}

/**
 * The batch-only PostgreSQL substrate the progressive series path requires: no
 * interactive scope, one atomic batch per segment. A real provider is used here
 * (and only here) because a record series consumes generated outputs across its
 * members, which a canned-row fake cannot supply.
 */
class BatchOnlySegmentDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
}

interface Case {
  readonly title: string;
  readonly driver: () => NamespaceDriver;
  /** The exact expected attribute value, or `undefined` for "no key at all". */
  readonly namespace: string | undefined;
}

const CASES: readonly Case[] = [
  {
    title: "PostgreSQL reports the configured schema",
    driver: () =>
      new NamespaceDriver("postgresql", new PostgresAdapter("billing")),
    namespace: "billing",
  },
  {
    title: "PostgreSQL reports the defaulted public schema",
    driver: () => new NamespaceDriver("postgresql", new PostgresAdapter()),
    namespace: "public",
  },
  {
    title: "bound MySQL reports the configured database",
    driver: () => new NamespaceDriver("mysql", new MySQLAdapter("shop")),
    namespace: "shop",
  },
  {
    title: "unbound MySQL omits the key",
    driver: () => new NamespaceDriver("mysql", new MySQLAdapter()),
    namespace: undefined,
  },
  {
    title: "SQLite omits the key",
    driver: () => new NamespaceDriver("sqlite", new SQLiteAdapter()),
    namespace: undefined,
  },
];

let recorder: OtelRecorder;
let seriesDatabase: PGlite;

beforeAll(async () => {
  recorder = withOtelRecorder();
  seriesDatabase = new PGlite();
  await seriesDatabase.exec('CREATE SCHEMA "billing"');
  await seriesDatabase.exec(
    'CREATE TABLE "billing"."ns_series_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)'
  );
  await seriesDatabase.exec(
    'CREATE TABLE "billing"."ns_series_notes" ("id" TEXT PRIMARY KEY, "body" TEXT NOT NULL, "seriesAccountId" TEXT NOT NULL)'
  );
});

afterAll(async () => {
  await recorder.dispose();
});

function instrumented(driver: NamespaceDriver) {
  return createClient({ schema, driver }).$extends(
    instrumentation({ tracing: true })
  );
}

/**
 * Assert one span's attribute against the case.
 *
 * The two arms are deliberately different assertions: a known namespace is
 * compared to the adapter's own value (so the attribute cannot drift into a
 * copy that stopped tracking it), and an unknown one is asserted as a MISSING
 * KEY rather than an undefined value.
 */
function expectNamespace(
  attributes: Readonly<Record<string, unknown>> | undefined,
  expected: string | undefined,
  spanName: string
): void {
  if (attributes === undefined) {
    throw new Error(`no ${spanName} span was recorded`);
  }
  // The span carries db.* at all — otherwise "no db.namespace" would be
  // trivially true and this assertion would prove nothing.
  expect(attributes[ATTR_DB_SYSTEM]).toBeDefined();
  if (expected === undefined) {
    expect(Object.hasOwn(attributes, ATTR_DB_NAMESPACE)).toBe(false);
    return;
  }
  expect(attributes[ATTR_DB_NAMESPACE]).toBe(expected);
}

/**
 * The OTel global provider registers once per process, so the recorder is
 * shared by every test in this file. Take a mark before the work and search
 * only the spans after it, or a later case reads an earlier case's span and
 * every assertion passes for the wrong reason.
 */
const mark = () => recorder.spans().length;
const since = (index: number, name: string) =>
  recorder
    .spans()
    .slice(index)
    .find((span) => span.name === name)?.attributes;

describe.each(CASES)("$title", ({ driver: makeDriver, namespace }) => {
  it("reports it on the operation and statement units", async () => {
    const driver = makeDriver();
    const client = instrumented(driver);
    const from = mark();
    await client.account.findMany({});

    expectNamespace(since(from, SPAN_OPERATION), namespace, SPAN_OPERATION);
    expectNamespace(since(from, SPAN_EXECUTE), namespace, SPAN_EXECUTE);
    // Read straight off the adapter: the attribute is that value, not a copy.
    expect(since(from, SPAN_OPERATION)?.[ATTR_DB_NAMESPACE]).toBe(
      driver.adapter.namespace
    );
    await client.$disconnect();
  });

  it("reports it on the driver-lifecycle units", async () => {
    const driver = makeDriver();
    const client = instrumented(driver);
    const from = mark();
    await client.$connect();
    await client.$transaction(async (tx) => {
      await tx.account.findMany({});
    });

    expectNamespace(since(from, SPAN_CONNECT), namespace, SPAN_CONNECT);
    expectNamespace(since(from, SPAN_TRANSACTION), namespace, SPAN_TRANSACTION);
    await client.$disconnect();
  });

  it("reports it on the cache unit", async () => {
    // The cache kind's db.* attributes ride on its stale-while-revalidate
    // presentation — the one cache span built from the driver's base
    // attributes. So the entry has to actually go stale and revalidate.
    const driver = makeDriver();
    const clock = createTestClock();
    const background: Promise<unknown>[] = [];
    let revalidations = 0;
    const client = createClient({ schema, driver })
      .$extends(
        cacheExtension({
          driver: new ClockedMemoryCache(clock),
          waitUntil: (promise) => {
            background.push(promise);
          },
        })
      )
      .$extends(
        instrumentation({
          tracing: true,
          logging: {
            cache: (event) => {
              const { event: name, status } = event.meta ?? {};
              if (name === "revalidate" && status !== "start") {
                revalidations += 1;
              }
            },
          },
        })
      );

    await client.$withCache({ ttl: 30, swr: true }).account.findMany({});
    while (background.length > 0) await Promise.all(background.splice(0));
    clock.advance(40);

    const from = mark();
    await client.$withCache({ ttl: 30, swr: true }).account.findMany({});
    while (background.length > 0) await Promise.all(background.splice(0));
    expect(revalidations).toBeGreaterThan(0);

    // Both the stale foreground read and the cache's own revalidation publish a
    // `viborm.operation` span in this window; every one of them must agree.
    const operations = recorder
      .spans()
      .slice(from)
      .filter((span) => span.name === SPAN_OPERATION);
    expect(operations.length).toBeGreaterThanOrEqual(2);
    for (const span of operations) {
      expectNamespace(span.attributes, namespace, SPAN_OPERATION);
    }
    await client.$disconnect();
  });
});

describe("the kinds that carry no db.* attributes", () => {
  it("leaves segment spans alone", async () => {
    // A relation-bearing bulk write on a batch-only substrate is a RECORD SERIES
    // run as progressive segments, which is the only route that opens this span.
    // The driver is bound to a schema, so the same window carries an operation
    // span that DOES report `db.namespace` — without that control, "the segment
    // has no db.namespace" would also be true of a window with no tracing at all.
    const driver = new BatchOnlySegmentDriver({
      client: seriesDatabase,
      namespace: "billing",
    });
    const client = createClient({ schema: seriesSchema, driver }).$extends(
      instrumentation({ tracing: true })
    );
    const from = mark();
    await client.seriesAccount.createMany({
      data: [
        {
          id: "a1",
          label: "one",
          notes: { create: [{ id: "n1", body: "b" }] },
        },
        {
          id: "a2",
          label: "two",
          notes: { create: [{ id: "n2", body: "c" }] },
        },
      ],
    });

    expectNamespace(since(from, SPAN_OPERATION), "billing", SPAN_OPERATION);
    const segments = recorder
      .spans()
      .slice(from)
      .filter((span) => span.name === SPAN_RECORD_SERIES_SEGMENT);
    // Each member commits in its own atomic unit, so the window holds several
    // segment spans. The count only has to be non-zero for the loop below to
    // assert anything at all — a zero here IS the vacuous-witness failure.
    expect(segments.length).toBeGreaterThan(0);
    for (const span of segments) {
      // A segment describes write atomicity, not a database connection: it never
      // carried db.system either, so adding db.namespace here would invent a
      // db.* surface this program does not own. The attributes come from a
      // frozen `viborm.write.*` literal that never reads the driver's base
      // attributes (`OperationExecutor.createProgressiveSegmentInstrumentationFacts`).
      expect(span.attributes[ATTR_VIBORM_WRITE_ATOMICITY]).toBe("segment");
      expect(Object.hasOwn(span.attributes, ATTR_DB_SYSTEM)).toBe(false);
      expect(Object.hasOwn(span.attributes, ATTR_DB_NAMESPACE)).toBe(false);
    }
    // Disconnecting closes the supplied PGlite, so this is the file's only
    // reader of `seriesDatabase`.
    await client.$disconnect();
  });

  it("leaves the cache backend's own get span alone", async () => {
    // `viborm.cache.get` describes a CACHE BACKEND call, not a database one: it
    // carries `db.cache.driver` and nothing from `db.*`. Reporting a SQL
    // namespace on it would attribute a memory/KV read to a schema.
    const driver = new NamespaceDriver(
      "postgresql",
      new PostgresAdapter("billing")
    );
    const client = createClient({ schema, driver })
      .$extends(cacheExtension({ driver: new MemoryCache() }))
      .$extends(instrumentation({ tracing: true }));
    const from = mark();
    await client.$withCache({ ttl: 60_000 }).account.findMany({});

    const get = since(from, SPAN_CACHE_GET);
    if (get === undefined) throw new Error("no cache get span was recorded");
    expect(Object.hasOwn(get, ATTR_DB_SYSTEM)).toBe(false);
    expect(Object.hasOwn(get, ATTR_DB_NAMESPACE)).toBe(false);
    await client.$disconnect();
  });
});

describe("the attribute is the adapter's value, and nothing else", () => {
  it("never reports a placeholder for an unknown namespace", async () => {
    const driver = new NamespaceDriver("mysql", new MySQLAdapter());
    const attributes = driver.getBaseAttributes();

    expect(Object.hasOwn(attributes, ATTR_DB_NAMESPACE)).toBe(false);
    expect(Object.values(attributes)).not.toContain("undefined");
    expect(Object.values(attributes)).not.toContain("");
    expect(Object.values(attributes)).not.toContain("null");
  });

  it("never carries a host, user, or connection secret", () => {
    const driver = new NamespaceDriver("mysql", new MySQLAdapter("shop"));
    expect(driver.getBaseAttributes()).toEqual({
      [ATTR_DB_SYSTEM]: "mysql",
      "db.system.driver": "namespace-attribute-mysql",
      [ATTR_DB_NAMESPACE]: "shop",
    });
  });
});
