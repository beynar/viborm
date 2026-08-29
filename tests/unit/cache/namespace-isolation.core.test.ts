/**
 * One cache extension, one backend, two namespaces — and no crossing.
 *
 * The hazard this closes is quiet: two clients that qualify their SQL to
 * different schemas but key their cache identically serve each other's rows for
 * a whole TTL and never fail. So these tests deliberately give both clients the
 * SAME `cache()` definition instance, the SAME backend, the SAME models, and
 * the SAME arguments — everything except the namespace — and then demand that
 * nothing they do is visible to the other: not a hit, not an invalidation, not
 * a stale-while-revalidate write, not a mutation's automatic eviction.
 *
 * The scope's derivation (and its exact bytes) is pinned next door in
 * `namespace-scope.core.test.ts`; what is proven HERE is that the derived value
 * is what actually reaches storage, on every one of those paths.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import type { CacheEntry } from "@cache/driver";
import { cache as cacheExtension } from "@cache/extension";
import { createOfficialCacheNamespace } from "@cache/key";
import { createClient } from "@client/client";
import { Driver, type QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { instrumentation } from "@instrumentation/extension";
import { s } from "@schema";
import { ClockedMemoryCache } from "@tests/fixtures/clocked-memory-cache";
import { createTestClock } from "@tests/fixtures/test-clock";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";

const account = s
  .model({
    id: s.string().id(),
    label: s.string(),
  })
  .map("cache_ns_accounts");
const schema = { account };

const TENANTS = ["alpha", "beta"] as const;
type Tenant = (typeof TENANTS)[number];

/**
 * A backend that reports what reaches storage.
 *
 * `live` mirrors what is actually held, so an eviction is observable; `written`
 * is the append-only history, so a background write is observable even after the
 * key it wrote is gone. Asserting on the history alone would let a crossed
 * eviction pass unnoticed, which is precisely the defect under test.
 */
class ObservableCache extends ClockedMemoryCache {
  readonly written: string[] = [];
  readonly clears: string[] = [];
  readonly deletes: string[] = [];
  private readonly live = new Set<string>();

  protected override async set<T>(
    key: string,
    storageTtl: number,
    entry: CacheEntry<T>
  ): Promise<void> {
    this.written.push(key);
    this.live.add(key);
    await super.set<T>(key, storageTtl, entry);
  }

  protected override async clear(prefix: string): Promise<void> {
    this.clears.push(prefix);
    for (const key of [...this.live]) {
      if (key.startsWith(prefix)) this.live.delete(key);
    }
    await super.clear(prefix);
  }

  protected override async delete(keys: string[]): Promise<void> {
    this.deletes.push(...keys);
    for (const key of keys) this.live.delete(key);
    await super.delete(keys);
  }

  /**
   * Write straight to storage, bypassing the public reserved-namespace refusal.
   * The only caller is the revision-bump test, which must place an entry at a
   * key the current code can no longer produce.
   */
  seed(key: string, value: unknown, storageTtl: number): Promise<void> {
    return this.set(key, storageTtl, {
      value,
      createdAt: 0,
      ttl: storageTtl,
    });
  }

  isHeld(key: string): boolean {
    return this.live.has(key);
  }

  storedKeys(): string[] {
    return this.written.slice();
  }
}

let database: PGlite;

const rowsFor = (tenant: Tenant) => [{ id: `${tenant}-1`, label: tenant }];

beforeAll(async () => {
  database = new PGlite();
  for (const tenant of TENANTS) {
    await database.exec(`CREATE SCHEMA "${tenant}"`);
    await database.exec(
      `CREATE TABLE "${tenant}"."cache_ns_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)`
    );
  }
});

beforeEach(async () => {
  for (const tenant of TENANTS) {
    await database.exec(`TRUNCATE TABLE "${tenant}"."cache_ns_accounts"`);
    for (const row of rowsFor(tenant)) {
      await database.exec(
        `INSERT INTO "${tenant}"."cache_ns_accounts" VALUES ('${row.id}', '${row.label}')`
      );
    }
  }
});

afterAll(async () => {
  // The database is supplied here, so this suite owns closing it.
  await database.close();
});

/**
 * Two clients that differ ONLY in namespace, over one shared definition and one
 * shared backend. `waitUntil` collects the background writes so a test can
 * state that the entry has landed instead of hoping.
 */
function tenants(version?: string | number) {
  const clock = createTestClock();
  const backend = new ObservableCache(clock);
  const background: Promise<unknown>[] = [];
  let finishedRevalidations = 0;
  const waiting: Array<{ target: number; resolve: () => void }> = [];
  // ONE definition instance appended to both clients: sharing it is the point.
  const definition = cacheExtension({
    driver: backend,
    version,
    waitUntil: (promise) => {
      background.push(promise);
    },
  });

  const clientFor = (tenant: Tenant) =>
    createClient({
      schema,
      driver: new PGliteDriver({ client: database, namespace: tenant }),
    })
      .$extends(definition)
      .$extends(
        instrumentation({
          logging: {
            cache: (event) => {
              const { event: name, status } = event.meta ?? {};
              if (name !== "revalidate" || status === "start") return;
              finishedRevalidations += 1;
              for (const waiter of waiting.splice(0)) {
                if (finishedRevalidations >= waiter.target) waiter.resolve();
                else waiting.push(waiter);
              }
            },
          },
        })
      );

  return {
    backend,
    clock,
    alpha: clientFor("alpha"),
    beta: clientFor("beta"),
    namespaceFor: (tenant: Tenant) =>
      createOfficialCacheNamespace({
        version,
        dialect: "postgresql",
        namespace: tenant,
      }),
    settle: async () => {
      while (background.length > 0) await Promise.all(background.splice(0));
    },
    nextRevalidation: (): Promise<void> => {
      const target = finishedRevalidations + 1;
      return new Promise<void>((resolve) => {
        waiting.push({ target, resolve });
      });
    },
  };
}

const IDENTICAL_READ = { orderBy: { id: "asc" } } as const;

describe("two namespaces over one cache definition and one backend", () => {
  test("identical reads keep their own seeded values, in both directions", async () => {
    const { alpha, beta, backend, settle, namespaceFor } = tenants();

    await expect(
      alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    await expect(
      beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("beta"));
    await settle();

    // Same model, same arguments, two entries — because the scope differs.
    expect(backend.storedKeys()).toHaveLength(2);
    const [alphaKey, betaKey] = backend.storedKeys();
    expect(alphaKey?.startsWith(`${namespaceFor("alpha")}:`)).toBe(true);
    expect(betaKey?.startsWith(`${namespaceFor("beta")}:`)).toBe(true);

    // Read back from cache: each still answers with its own rows.
    await expect(
      alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    await expect(
      beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("beta"));
  });

  test("a manual invalidation in one namespace leaves the other's entry", async () => {
    const { alpha, beta, backend, settle, namespaceFor } = tenants();

    await alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await settle();
    const betaKey = backend
      .storedKeys()
      .find((key) => key.startsWith(`${namespaceFor("beta")}:`));
    if (betaKey === undefined) throw new Error("no beta entry was stored");

    // Beta's rows change in the database. From here on, a beta read that
    // returns the ORIGINAL rows can only have come from beta's cache entry.
    await database.exec(
      `INSERT INTO "beta"."cache_ns_accounts" VALUES ('beta-2', 'beta')`
    );

    await alpha.$invalidate("account:*");

    expect(backend.clears).toEqual([`${namespaceFor("alpha")}:account:`]);
    expect(backend.isHeld(betaKey)).toBe(true);
    await expect(
      beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("beta"));

    // The reverse direction, on the same shared backend: now beta's own
    // invalidation does reach it, and the new row appears.
    await beta.$invalidate("account:*");
    expect(backend.clears).toEqual([
      `${namespaceFor("alpha")}:account:`,
      `${namespaceFor("beta")}:account:`,
    ]);
    expect(backend.isHeld(betaKey)).toBe(false);
    await expect(
      beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual([
      { id: "beta-1", label: "beta" },
      { id: "beta-2", label: "beta" },
    ]);
  });

  test("an automatic mutation invalidation cannot evict a sibling namespace", async () => {
    const { alpha, beta, backend, settle, namespaceFor } = tenants();

    await alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await settle();
    const betaKey = backend
      .storedKeys()
      .find((key) => key.startsWith(`${namespaceFor("beta")}:`));
    if (betaKey === undefined) throw new Error("no beta entry was stored");
    await database.exec(
      `INSERT INTO "beta"."cache_ns_accounts" VALUES ('beta-2', 'beta')`
    );

    await alpha.account.create({
      data: { id: "alpha-2", label: "alpha" },
      cache: { autoInvalidate: true },
    });

    // The write-outcome rail clears only the writing client's scope.
    expect(backend.clears).toEqual([`${namespaceFor("alpha")}:account:`]);
    expect(backend.isHeld(betaKey)).toBe(true);
    // Beta is still served its entry: the row it cannot see is the proof.
    await expect(
      beta.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("beta"));
  });

  test("stale-while-revalidate writes back only into its own scope", async () => {
    const {
      alpha,
      beta,
      backend,
      clock,
      settle,
      nextRevalidation,
      namespaceFor,
    } = tenants();

    await alpha
      .$withCache({ ttl: 30, swr: true })
      .account.findMany(IDENTICAL_READ);
    await beta
      .$withCache({ ttl: 30, swr: true })
      .account.findMany(IDENTICAL_READ);
    await settle();
    const keysAfterSeed = backend.storedKeys();
    expect(keysAfterSeed).toHaveLength(2);

    // Alpha's row set changes underneath, then its entry goes stale.
    await database.exec(
      `INSERT INTO "alpha"."cache_ns_accounts" VALUES ('alpha-2', 'alpha')`
    );
    clock.advance(40);
    const revalidated = nextRevalidation();
    await expect(
      alpha.$withCache({ ttl: 30, swr: true }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    await revalidated;
    await settle();

    // The background write landed on alpha's key only; beta's entry is intact
    // and still answers with beta's rows.
    const written = backend.storedKeys().slice(keysAfterSeed.length);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(key.startsWith(`${namespaceFor("alpha")}:`)).toBe(true);
    }
    await expect(
      beta.$withCache({ ttl: 30, swr: true }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("beta"));
  });
});

describe("the scope survives further extension", () => {
  test("an ordinary extension appended after the cache keeps the same scope", async () => {
    const { alpha, backend, settle, namespaceFor } = tenants();
    const extended = alpha.$extends({ name: "ordinary-after-cache" });

    await alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await settle();
    const seeded = backend.storedKeys();
    expect(seeded).toHaveLength(1);

    // The re-appended chain is a different object; its scope is re-derived from
    // the same facts, so it addresses the entry the first view wrote.
    await expect(
      extended.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    expect(backend.storedKeys()).toEqual(seeded);
    expect(seeded[0]?.startsWith(`${namespaceFor("alpha")}:`)).toBe(true);

    // …and invalidation from the extended view targets that same scope.
    await extended.$invalidate("account:*");
    expect(backend.clears).toEqual([`${namespaceFor("alpha")}:account:`]);
  });

  test("ten appended extensions still address one scope", async () => {
    const { alpha, backend, settle } = tenants();
    let view = alpha;
    for (let index = 0; index < 10; index += 1) {
      view = view.$extends({ name: `ordinary-${index}` });
    }

    await alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await settle();
    await expect(
      view.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    expect(backend.storedKeys()).toHaveLength(1);
  });
});

/**
 * Two clients that differ ONLY in cache `version`, where one version string is a
 * strict PREFIX of the other, on one namespace and one backend.
 *
 * `version` is the last component of the scope grammar and its `s:` body is
 * variable-length, so `"a"`'s scope is a strict string prefix of `"ab"`'s. The
 * backends clear by `startsWith`, which makes that prefix relation a crossing
 * unless the clear boundary carries the component separator.
 */
function siblingVersions(shortVersion: string, longVersion: string) {
  const backend = new ObservableCache(createTestClock());
  const background: Promise<unknown>[] = [];
  const clientFor = (version: string) =>
    createClient({
      schema,
      driver: new PGliteDriver({ client: database, namespace: "alpha" }),
    }).$extends(
      cacheExtension({
        driver: backend,
        version,
        waitUntil: (promise) => {
          background.push(promise);
        },
      })
    );

  return {
    backend,
    short: clientFor(shortVersion),
    long: clientFor(longVersion),
    namespaceFor: (version: string) =>
      createOfficialCacheNamespace({
        version,
        dialect: "postgresql",
        namespace: "alpha",
      }),
    settle: async () => {
      while (background.length > 0) await Promise.all(background.splice(0));
    },
  };
}

describe("a clear-all stops at the scope that issued it", () => {
  test('$invalidate("*") cannot reach a version whose name it prefixes', async () => {
    const { short, long, backend, settle, namespaceFor } = siblingVersions(
      "a",
      "ab"
    );

    await short.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await long.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ);
    await settle();
    const longKey = backend
      .storedKeys()
      .find((key) => key.startsWith(`${namespaceFor("ab")}:`));
    if (longKey === undefined) {
      throw new Error("no entry was stored for the longer version");
    }
    expect(backend.isHeld(longKey)).toBe(true);

    // The rows change underneath, so a later `ab` read that answers with the
    // ORIGINAL rows can only have come from that surviving entry.
    await database.exec(
      `INSERT INTO "alpha"."cache_ns_accounts" VALUES ('alpha-2', 'alpha')`
    );

    await short.$invalidate("*");

    // The sibling scope is untouched, and its entry is still served: the row it
    // cannot see is the proof.
    expect(backend.isHeld(longKey)).toBe(true);
    await expect(
      long.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    // …because the clear carried the scope's own separator.
    expect(backend.clears).toEqual([`${namespaceFor("a")}:`]);

    // The reverse direction on the same backend: its own clear-all does reach
    // it, and the new row appears.
    await long.$invalidate("*");
    expect(backend.isHeld(longKey)).toBe(false);
    await expect(
      long.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual([
      { id: "alpha-1", label: "alpha" },
      { id: "alpha-2", label: "alpha" },
    ]);
  });

  test("the namespace axis was never crossable this way", () => {
    // The control: a namespace body is followed by the version component, so no
    // namespace scope can be a string prefix of a sibling's — `alpha` vs
    // `alphabet` included. Only the trailing version needed the delimiter.
    const scopeFor = (namespace: string) =>
      createOfficialCacheNamespace({
        version: "a",
        dialect: "postgresql",
        namespace,
      });

    expect(scopeFor("alphabet").startsWith(scopeFor("alpha"))).toBe(false);
    expect(scopeFor("alpha").startsWith(scopeFor("alphabet"))).toBe(false);
  });
});

const MYSQL_ROWS = [{ id: "mysql-1", label: "mysql" }];

/** The same rows as provider text, which is the shape a driver decodes. */
const MYSQL_PROVIDER_ROWS = JSON.stringify(MYSQL_ROWS);

/**
 * A MySQL client whose rows are TAGGED, so an entry served across the dialect
 * boundary shows up in the returned value and not only in a key.
 */
class TaggedMySQLDriver extends Driver<object, object> {
  readonly adapter: DatabaseAdapter = new MySQLAdapter("alpha");

  constructor() {
    super("mysql", "tagged-mysql");
    this.client = {};
  }

  protected async initClient(): Promise<object> {
    return {};
  }

  protected async closeClient(): Promise<void> {
    // No provider resource.
  }

  protected async execute<T>(): Promise<QueryResult<T>> {
    const rows: T[] = JSON.parse(MYSQL_PROVIDER_ROWS);
    return { rows, rowCount: rows.length };
  }

  protected async executeRaw<T>(): Promise<QueryResult<T>> {
    return this.execute<T>();
  }

  protected transaction<T>(
    client: object,
    run: (transaction: object) => Promise<T>
  ): Promise<T> {
    return run(client);
  }
}

/**
 * The scope partitions on `dialect` as well as namespace, because a PostgreSQL
 * schema `alpha` and a MySQL database `alpha` are different stores that spell
 * their qualifier the same way. That makes the driver's `dialect` a cache
 * identity fact, and a writable one would let JavaScript that never touches the
 * cache API relabel a PostgreSQL driver and read another store's rows.
 */
describe("a forged dialect cannot address another dialect's scope", () => {
  test("a PostgreSQL driver relabelled 'mysql' before cache() binds reads only its own scope", async () => {
    const backend = new ObservableCache(createTestClock());
    const background: Promise<unknown>[] = [];
    const settle = async () => {
      while (background.length > 0) await Promise.all(background.splice(0));
    };
    // ONE definition, ONE backend, the SAME version and namespace spelling:
    // the dialect is the only fact left that separates the two scopes.
    const definition = cacheExtension({
      driver: backend,
      version: 7,
      waitUntil: (promise) => {
        background.push(promise);
      },
    });

    const mysql = createClient({
      schema,
      driver: new TaggedMySQLDriver(),
    }).$extends(definition);

    const postgresDriver = new PGliteDriver({
      client: database,
      namespace: "alpha",
    });
    // The forgery, performed BEFORE the composition root derives the scope.
    const relabelled = Reflect.set(postgresDriver, "dialect", "mysql");
    const postgres = createClient({
      schema,
      driver: postgresDriver,
    }).$extends(definition);

    await expect(
      mysql.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(MYSQL_ROWS);
    await settle();
    expect(backend.storedKeys()).toHaveLength(1);

    // The PostgreSQL client answers with its OWN rows. A crossed hit would
    // return the tagged MySQL rows instead, from a store it never connected to.
    await expect(
      postgres.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
    await settle();

    expect(relabelled).toBe(false);
    expect(postgresDriver.dialect).toBe("postgresql");
    // Two entries, not one shared: and the MySQL client is not poisoned either.
    expect(backend.storedKeys()).toHaveLength(2);
    await expect(
      mysql.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(MYSQL_ROWS);
  });
});

describe("the snapshot revision partitions old storage", () => {
  test("an r1-shaped entry is never served to an r3 reader", async () => {
    const { alpha, backend, settle } = tenants();

    // The exact key the previous revision would have used for a namespace-blind
    // unversioned scope. Seeded directly: the public surface refuses to write
    // anything inside the reserved official root.
    const firstRead = await alpha
      .$withCache({ ttl: 60_000 })
      .account.findMany(IDENTICAL_READ);
    await settle();
    const [liveKey] = backend.storedKeys();
    if (liveKey === undefined) throw new Error("no entry was stored");
    const suffix = liveKey.slice(liveKey.lastIndexOf(":account:"));
    await backend.seed(
      `viborm:cache:r1:u${suffix}`,
      [{ id: "stale-r1", label: "stale-r1" }],
      60_000
    );

    expect(firstRead).toEqual(rowsFor("alpha"));
    expect(liveKey.startsWith("viborm:cache:r3:")).toBe(true);
    // The r1 entry sits in the same backend and is simply unreachable.
    await expect(
      alpha.$withCache({ ttl: 60_000 }).account.findMany(IDENTICAL_READ)
    ).resolves.toEqual(rowsFor("alpha"));
  });
});
