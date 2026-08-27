/**
 * The public `namespace` option and MySQL2's transport attestation, at every
 * boundary that accepts them: the seven driver constructors, the seven
 * convenience wrappers, and the immutable facts they install.
 *
 * Three things are proven here that no type can prove: the caller's object is
 * read exactly once, an invalid value is refused before any provider work, and
 * neither the resolved target nor the assertion can be replaced afterwards.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { VibORM } from "@client/client";
import { Driver, TransactionBoundDriver } from "@drivers";
import {
  BunSQLDriver,
  createClient as createBunSQLClient,
} from "@drivers/bun-sql";
import {
  createClient as createMySQL2Client,
  MySQL2Driver,
} from "@drivers/mysql2";
import {
  createClient as createNeonClient,
  NeonHTTPDriver,
} from "@drivers/neon-http";
import { createClient as createPgClient, PgDriver } from "@drivers/pg";
import {
  createClient as createPGliteClient,
  PGliteDriver,
} from "@drivers/pglite";
import {
  createClient as createPlanetScaleClient,
  PlanetScaleDriver,
} from "@drivers/planetscale";
import {
  createClient as createPostgresClient,
  PostgresDriver,
} from "@drivers/postgres";
import { SQLite3Driver } from "@drivers/sqlite3";
import type { QueryResult } from "@drivers/types";
import { ClientInitializationError } from "@errors";
import { Client as PlanetScaleClient } from "@planetscale/database";
import { clientUserPostSchema } from "@tests/fixtures/user-post-schema";
import { afterEach, describe, expect, test, vi } from "vitest";

const createdPools: Record<string, unknown>[] = [];

vi.mock("mysql2/promise", () => ({
  createPool: (options: Record<string, unknown>) => {
    createdPools.push(options);
    return { end: () => Promise.resolve() };
  },
}));

afterEach(() => {
  createdPools.length = 0;
  vi.restoreAllMocks();
});

/** The refusal a boundary raised, or a loud failure if it raised nothing. */
function refusalFrom(build: () => unknown): ClientInitializationError {
  try {
    build();
  } catch (thrown) {
    if (thrown instanceof ClientInitializationError) return thrown;
    throw thrown;
  }
  throw new Error("expected a ClientInitializationError");
}

/** The driver a wrapper actually handed to the client, without connecting. */
function driverFromWrapper(build: () => unknown) {
  const created = vi.spyOn(VibORM, "create");
  build();
  const config = created.mock.calls[0]?.[0];
  if (!config) throw new Error("the wrapper did not construct a client");
  return config.driver;
}

const schema = clientUserPostSchema;

// ============================================================
// DIRECT CONSTRUCTION
// ============================================================

describe("PostgreSQL drivers bind a schema", () => {
  const constructors = [
    ["pg", (namespace?: string) => new PgDriver({ namespace })],
    ["postgres.js", (namespace?: string) => new PostgresDriver({ namespace })],
    ["pglite", (namespace?: string) => new PGliteDriver({ namespace })],
    ["neon-http", (namespace?: string) => new NeonHTTPDriver({ namespace })],
    ["bun-sql", (namespace?: string) => new BunSQLDriver({ namespace })],
  ] as const;

  test.each(
    constructors
  )("%s accepts an explicit namespace", (_name, build) => {
    expect(build("alpha").adapter.namespace).toBe("alpha");
  });

  test.each(
    constructors
  )("%s treats absent and explicit undefined as public", (_name, build) => {
    expect(build().adapter.namespace).toBe("public");
    expect(build(undefined).adapter.namespace).toBe("public");
  });

  test.each(constructors)("%s refuses a system schema", (_name, build) => {
    expect(() => build("pg_temp_1")).toThrow(ClientInitializationError);
    expect(() => build("information_schema")).toThrow(
      ClientInitializationError
    );
  });

  test.each(constructors)("%s refuses an invalid name", (_name, build) => {
    expect(() => build("")).toThrow(ClientInitializationError);
    expect(() => build("alpha.beta")).toThrow(ClientInitializationError);
    expect(() => build("a".repeat(64))).toThrow(ClientInitializationError);
  });
});

describe("MySQL drivers", () => {
  test("mysql2 accepts an explicit namespace", () => {
    expect(new MySQL2Driver({ namespace: "alpha" }).adapter.namespace).toBe(
      "alpha"
    );
  });

  test("planetscale accepts an explicit keyspace qualifier", () => {
    expect(
      new PlanetScaleDriver({ namespace: "alpha" }).adapter.namespace
    ).toBe("alpha");
  });

  test.each([
    "@primary",
    "@replica",
  ])("planetscale refuses the routing selector %s as a namespace", (namespace) => {
    expect(() => new PlanetScaleDriver({ namespace })).toThrow(
      ClientInitializationError
    );
  });

  test("mysql2 refuses a system database", () => {
    expect(() => new MySQL2Driver({ namespace: "SYS" })).toThrow(
      ClientInitializationError
    );
  });
});

// ============================================================
// MYSQL2 TARGET PRECEDENCE
// ============================================================

describe("MySQL2 resolves one target in order", () => {
  test("explicit namespace wins over a URL path and options.database", () => {
    const driver = new MySQL2Driver({
      namespace: "explicit_db",
      databaseUrl: "mysql://user:pw@host:3306/url_db",
      options: { database: "options_db" },
    });

    expect(driver.adapter.namespace).toBe("explicit_db");
  });

  test("a URL path wins over options.database", () => {
    const driver = new MySQL2Driver({
      databaseUrl: "mysql://user:pw@host:3306/url_db",
      options: { database: "options_db" },
    });

    expect(driver.adapter.namespace).toBe("url_db");
  });

  test("options.database binds when no URL path supplies one", () => {
    expect(
      new MySQL2Driver({ options: { database: "options_db" } }).adapter
        .namespace
    ).toBe("options_db");
  });

  test("a pathless URL contributes nothing and is not an empty candidate", () => {
    expect(
      new MySQL2Driver({ databaseUrl: "mysql://user:pw@host:3306" }).adapter
        .namespace
    ).toBeUndefined();
    expect(
      new MySQL2Driver({ databaseUrl: "mysql://user:pw@host:3306/" }).adapter
        .namespace
    ).toBeUndefined();
    expect(
      new MySQL2Driver({
        databaseUrl: "mysql://user:pw@host:3306/",
        options: { database: "options_db" },
      }).adapter.namespace
    ).toBe("options_db");
  });

  test("an explicit undefined defers to the same derivation as an absent one", () => {
    expect(
      new MySQL2Driver({
        namespace: undefined,
        options: { database: "options_db" },
      }).adapter.namespace
    ).toBe("options_db");
    expect(
      new MySQL2Driver({
        namespace: undefined,
        databaseUrl: "mysql://user:pw@host:3306/url_db",
      }).adapter.namespace
    ).toBe("url_db");
  });

  test("no configuration at all stays unqualified", () => {
    expect(new MySQL2Driver().adapter.namespace).toBeUndefined();
    expect(new MySQL2Driver({ options: {} }).adapter.namespace).toBeUndefined();
  });

  test("a supplied pool is opaque: only the explicit option binds it", async () => {
    // The mocked provider module returns the same stub a driver-created pool
    // would be, so this is a supplied pool with the provider's own type.
    const { createPool } = await import("mysql2/promise");
    const pool = createPool({});

    expect(
      new MySQL2Driver({
        pool,
        databaseUrl: "mysql://user:pw@host:3306/url_db",
        options: { database: "options_db" },
      }).adapter.namespace
    ).toBeUndefined();
    expect(
      new MySQL2Driver({ pool, namespace: "explicit_db" }).adapter.namespace
    ).toBe("explicit_db");
  });

  test("a derived target is validated like an explicit one", () => {
    expect(
      () => new MySQL2Driver({ databaseUrl: "mysql://host/app-dev" })
    ).toThrow(ClientInitializationError);
    expect(
      () => new MySQL2Driver({ options: { database: "information_schema" } })
    ).toThrow(ClientInitializationError);
  });

  test("an empty derived database is an absent candidate, not an empty name", () => {
    // §1.3: an empty candidate "is not passed to identifier validation as an
    // empty candidate". Whitespace is not empty — it is a name the ORM could
    // never qualify with, so it stays a refusal (ruling N24).
    expect(
      new MySQL2Driver({ options: { database: "" } }).adapter.namespace
    ).toBeUndefined();
    expect(() => new MySQL2Driver({ options: { database: " " } })).toThrow(
      ClientInitializationError
    );
    expect(() => new MySQL2Driver({ options: { database: "\t" } })).toThrow(
      ClientInitializationError
    );
  });

  test("a malformed URL fails at construction, not at connect", () => {
    expect(() => new MySQL2Driver({ databaseUrl: "not a url" })).toThrow(
      ClientInitializationError
    );
  });
});

describe("both construction paths read databaseUrl the same way", () => {
  test("an empty, null, or absent URL is the same absent request", () => {
    expect(
      new MySQL2Driver({ databaseUrl: "" }).adapter.namespace
    ).toBeUndefined();
    expect(
      driverFromWrapper(() => createMySQL2Client({ schema, databaseUrl: "" }))
        .adapter.namespace
    ).toBeUndefined();
    // `null` is what JSON-sourced configuration puts there; it cannot arrive
    // through the TypeScript surface.
    expect(
      new MySQL2Driver({ ...JSON.parse('{"databaseUrl": null}') }).adapter
        .namespace
    ).toBeUndefined();
    expect(
      driverFromWrapper(() =>
        createMySQL2Client({ schema, ...JSON.parse('{"databaseUrl": null}') })
      ).adapter.namespace
    ).toBeUndefined();
  });

  test("a malformed URL refuses on both paths, even behind an explicit namespace", () => {
    // A present URL is parsed eagerly wherever it appears: the explicit option
    // decides the target, but it does not excuse an unusable connection string.
    expect(
      () => new MySQL2Driver({ namespace: "alpha", databaseUrl: "bad url" })
    ).toThrow(ClientInitializationError);
    expect(() =>
      createMySQL2Client({ schema, namespace: "alpha", databaseUrl: "bad url" })
    ).toThrow(ClientInitializationError);
  });
});

describe("MySQL2's adjacent option refusals are construction failures", () => {
  // N7: these three raised `QueryError` before this feature. The message pin
  // in provider-result-contracts is class-blind; this is the class witness.
  test.each([
    ["multipleStatements", { multipleStatements: true }],
    ["rowsAsArray", { rowsAsArray: true }],
    ["nestTables", { nestTables: true }],
    ["nestTables as a separator", { nestTables: "_" }],
  ])("refuses options.%s", (_label, options) => {
    expect(() => new MySQL2Driver({ options })).toThrow(
      ClientInitializationError
    );
  });
});

describe("the driver-created pool defaults to the bound database", () => {
  const connect = async (driver: MySQL2Driver) => {
    await driver._connect();
    await driver._disconnect();
    return createdPools[0];
  };

  test("an explicit namespace becomes the copied pool default", async () => {
    expect(
      await connect(
        new MySQL2Driver({
          namespace: "explicit_db",
          databaseUrl: "mysql://user:pw@host:3306/url_db",
          options: { database: "options_db" },
        })
      )
    ).toMatchObject({ database: "explicit_db", host: "host", port: 3306 });
  });

  test("a URL path still mirrors the effective pool options", async () => {
    expect(
      await connect(
        new MySQL2Driver({
          databaseUrl: "mysql://user:pw@host:3306/url_db",
          options: { database: "options_db" },
        })
      )
    ).toMatchObject({ database: "url_db" });
  });

  test("a pathless URL leaves options.database in place", async () => {
    expect(
      await connect(
        new MySQL2Driver({
          databaseUrl: "mysql://user:pw@host:3306",
          options: { database: "options_db" },
        })
      )
    ).toMatchObject({ database: "options_db" });
  });

  test("an unbound driver sets no database at all", async () => {
    const pool = await connect(new MySQL2Driver({ options: { host: "h" } }));
    expect(pool && "database" in pool).toBe(false);
  });

  test("the databaseUrl settles once and the pool follows that one parse", async () => {
    // The target and the pool must come from the same URL. A second read is
    // what would let the validated URL be swapped for another before the
    // provider is handed one.
    let reads = 0;
    const driver = new MySQL2Driver({
      get databaseUrl() {
        reads += 1;
        return reads === 1
          ? "mysql://first_host:3306/first_db"
          : "mysql://second_host:3306/second_db";
      },
    });

    expect([reads, driver.adapter.namespace]).toEqual([1, "first_db"]);
    expect(await connect(driver)).toMatchObject({
      host: "first_host",
      database: "first_db",
    });
    expect(reads).toBe(1);
  });
});

// ============================================================
// CALLER-OWNED OBJECTS
// ============================================================

describe("construction never mutates the caller's options record", () => {
  test("mysql2 wrapper leaves the caller's options untouched", () => {
    const options = { database: "options_db", host: "original" };

    createMySQL2Client({
      schema,
      options,
      databaseUrl: "mysql://user:pw@urlhost:3306/url_db",
    });

    expect(options).toEqual({ database: "options_db", host: "original" });
  });

  test("postgres.js wrapper leaves the caller's options untouched", () => {
    const options = { host: "original" };

    createPostgresClient({
      schema,
      options,
      databaseUrl: "postgres://user:pw@urlhost:5432/db",
    });

    expect(options).toEqual({ host: "original" });
  });

  test("pg wrapper leaves the caller's options untouched", () => {
    const options = { host: "original" };

    createPgClient({
      schema,
      options,
      databaseUrl: "postgres://user:pw@urlhost:5432/db",
    });

    expect(options).toEqual({ host: "original" });
  });

  test("the URL still wins in the options the driver receives", () => {
    const driver = driverFromWrapper(() =>
      createMySQL2Client({
        schema,
        options: { database: "options_db" },
        databaseUrl: "mysql://user:pw@urlhost:3306/url_db",
      })
    );

    expect(driver.adapter.namespace).toBe("url_db");
  });

  test("mutating the options object after construction changes nothing", () => {
    const options: { namespace?: string; database?: string } = {
      namespace: "alpha",
    };
    const driver = new MySQL2Driver(options);

    options.namespace = "victim";
    options.database = "victim";

    expect(driver.adapter.namespace).toBe("alpha");
  });
});

describe("hostile option accessors", () => {
  test("the namespace getter settles once", () => {
    let reads = 0;
    const options = {
      get namespace() {
        reads += 1;
        return reads === 1 ? "alpha" : "pg_catalog";
      },
    };

    const driver = new PgDriver(options);

    expect(reads).toBe(1);
    expect(driver.adapter.namespace).toBe("alpha");
  });

  test("the attestation getter settles once", () => {
    let reads = 0;
    const options = {
      get migrationNamespaceAttestation() {
        reads += 1;
        return reads === 1 ? ("non-redirecting" as const) : undefined;
      },
    };

    const driver = new MySQL2Driver(options);

    expect(reads).toBe(1);
    expect(driver.migrationNamespaceAttestation).toBe("non-redirecting");
  });

  test("a thrown Error is carried as the refusal's cause", () => {
    const refusal = refusalFrom(
      () =>
        new PgDriver({
          get namespace(): string {
            throw new RangeError("provider secret");
          },
        })
    );

    expect(refusal.originalCause).toBeInstanceOf(Error);
    expect(refusal.message).toContain('"namespace"');
    // The error framework redacts a cause's own message; what matters here is
    // that the accessor's failure is preserved rather than swallowed.
    expect(refusal.message).not.toContain("provider secret");
  });

  test("a non-Error throw is normalized without being rendered", () => {
    const hostile = {
      toString() {
        throw new Error("a hostile value was rendered");
      },
    };

    const refusal = refusalFrom(
      () =>
        new MySQL2Driver({
          get migrationNamespaceAttestation(): "non-redirecting" {
            throw hostile;
          },
        })
    );

    expect(refusal.originalCause).toBeInstanceOf(Error);
    expect(refusal.message).toBe(
      'The "migrationNamespaceAttestation" option could not be read.'
    );
  });

  test("an ordinary invalid value fabricates no cause", () => {
    expect(
      refusalFrom(() => new PgDriver({ namespace: "pg_catalog" })).originalCause
    ).toBeUndefined();
  });

  test("a wrapper reads the caller's getters exactly once each", () => {
    // The wrapper hands its driver a fresh options record, so the caller's
    // accessor is never consulted a second time on the way down.
    let namespaceReads = 0;
    let attestationReads = 0;
    const config = {
      schema,
      get namespace() {
        namespaceReads += 1;
        return namespaceReads === 1 ? "alpha" : "sys";
      },
      get migrationNamespaceAttestation() {
        attestationReads += 1;
        return attestationReads === 1
          ? ("non-redirecting" as const)
          : undefined;
      },
    };

    const driver = driverFromWrapper(() => createMySQL2Client(config));

    expect([namespaceReads, attestationReads]).toEqual([1, 1]);
    expect(driver.adapter.namespace).toBe("alpha");
    expect(driver.migrationNamespaceAttestation).toBe("non-redirecting");
  });

  test("a wrapper's hostile getter fails before any client exists", () => {
    const created = vi.spyOn(VibORM, "create");

    expect(() =>
      createPgClient({
        schema,
        get namespace(): string {
          throw new Error("boom");
        },
      })
    ).toThrow(ClientInitializationError);
    expect(created).not.toHaveBeenCalled();
  });

  /**
   * A value whose `instanceof Error` test itself THROWS.
   *
   * `instanceof` walks the prototype chain through `[[GetPrototypeOf]]`, so a
   * Proxy trap that throws makes the test fail rather than the value. The
   * normalizer runs inside this boundary's `catch`, which is what makes the
   * shape worth pinning: a throw there does not merely lose the cause, it
   * replaces the `ClientInitializationError` the boundary promised with the
   * trap's own error — and a caller catching the typed refusal catches nothing.
   */
  function prototypeTrapProxy(): unknown {
    return new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap");
        },
      }
    );
  }

  test("a namespace getter's getPrototypeOf trap cannot replace the refusal", () => {
    let reads = 0;
    const hostile = prototypeTrapProxy();

    const refusal = refusalFrom(
      () =>
        new PgDriver({
          get namespace(): string {
            reads += 1;
            throw hostile;
          },
        })
    );

    expect(reads).toBe(1);
    expect(refusal.message).toBe('The "namespace" option could not be read.');
    // Normalized rather than dropped: the accessor's failure is the only thing
    // the caller has to go on, and it is not rendered on the way through.
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });

  test("an attestation getter's getPrototypeOf trap cannot replace the refusal", () => {
    let reads = 0;
    const hostile = prototypeTrapProxy();

    const refusal = refusalFrom(
      () =>
        new MySQL2Driver({
          get migrationNamespaceAttestation(): "non-redirecting" {
            reads += 1;
            throw hostile;
          },
        })
    );

    expect(reads).toBe(1);
    expect(refusal.message).toBe(
      'The "migrationNamespaceAttestation" option could not be read.'
    );
    expect(refusal.originalCause).toBeInstanceOf(Error);
  });
});

describe("only the caller's own properties are a request", () => {
  /**
   * An inherited `namespace` or attestation is `Object.prototype` pollution or
   * a carrier's prototype — never a value this caller wrote down. Honouring one
   * would let unrelated code forge both the qualification target and the
   * migration-admission fact for every driver constructed with no options at
   * all. The window is closed synchronously so nothing else observes it.
   */
  function withPolluted<T>(key: string, value: string, run: () => T): T {
    Reflect.set(Object.prototype, key, value);
    try {
      return run();
    } finally {
      Reflect.deleteProperty(Object.prototype, key);
    }
  }

  test("an inherited namespace binds no direct driver", () => {
    withPolluted("namespace", "attacker_schema", () => {
      expect(new PgDriver().adapter.namespace).toBe("public");
      expect(new PlanetScaleDriver().adapter.namespace).toBeUndefined();
      expect(new MySQL2Driver().adapter.namespace).toBeUndefined();
    });
  });

  test("an inherited attestation proves nothing", () => {
    withPolluted("migrationNamespaceAttestation", "non-redirecting", () => {
      expect(new MySQL2Driver().migrationNamespaceAttestation).toBeUndefined();
    });
  });

  test("an inherited namespace never reaches a wrapper's driver", () => {
    withPolluted("namespace", "attacker_schema", () => {
      expect(
        driverFromWrapper(() => createPgClient({ schema })).adapter.namespace
      ).toBe("public");
    });
  });

  test("a carrier object's prototype namespace is invisible", () => {
    const carrier = Object.create({ namespace: "injected" });

    expect(new PgDriver(carrier).adapter.namespace).toBe("public");
    expect(new MySQL2Driver(carrier).adapter.namespace).toBeUndefined();
  });
});

// ============================================================
// ATTESTATION
// ============================================================

describe("MySQL2 attestation", () => {
  test("only the exact literal produces the fact", () => {
    expect(
      new MySQL2Driver({ migrationNamespaceAttestation: "non-redirecting" })
        .migrationNamespaceAttestation
    ).toBe("non-redirecting");
  });

  test("omitted and explicitly undefined stay unproven", () => {
    expect(new MySQL2Driver().migrationNamespaceAttestation).toBeUndefined();
    expect(
      new MySQL2Driver({ migrationNamespaceAttestation: undefined })
        .migrationNamespaceAttestation
    ).toBeUndefined();
  });

  test.each([
    ["a boolean", '{"migrationNamespaceAttestation": true}'],
    ["another literal", '{"migrationNamespaceAttestation": "non_redirecting"}'],
    ["a near miss", '{"migrationNamespaceAttestation": "nonredirecting"}'],
    ["an empty string", '{"migrationNamespaceAttestation": ""}'],
    ["a number", '{"migrationNamespaceAttestation": 1}'],
    [
      "an object",
      '{"migrationNamespaceAttestation": {"v": "non-redirecting"}}',
    ],
  ])("refuses %s", (_label, json) => {
    // Spelled as configuration that arrived from outside TypeScript, which is
    // the only way these values can reach the option at all.
    expect(() => new MySQL2Driver({ ...JSON.parse(json) })).toThrow(
      ClientInitializationError
    );
    // §10: the refusal lands before provider initialization. What this catches
    // that the refusal itself cannot is a constructor that creates its pool
    // first and refuses afterwards, leaking a connection on every rejection.
    expect(createdPools).toHaveLength(0);
  });

  test("no target source creates one", () => {
    const derived = new MySQL2Driver({
      databaseUrl: "mysql://user:pw@host:3306/url_db",
      options: { database: "options_db" },
    });
    const explicit = new MySQL2Driver({ namespace: "alpha" });

    expect(derived.migrationNamespaceAttestation).toBeUndefined();
    expect(explicit.migrationNamespaceAttestation).toBeUndefined();
  });

  test("every other stock driver has an immutable undefined", () => {
    const drivers = [
      new PgDriver(),
      new PostgresDriver(),
      new PGliteDriver(),
      new NeonHTTPDriver(),
      new BunSQLDriver(),
      new PlanetScaleDriver({ namespace: "alpha" }),
      new SQLite3Driver(),
    ];

    for (const driver of drivers) {
      expect(driver.migrationNamespaceAttestation).toBeUndefined();
      expect(
        Reflect.set(driver, "migrationNamespaceAttestation", "non-redirecting")
      ).toBe(false);
      expect(() =>
        Object.defineProperty(driver, "migrationNamespaceAttestation", {
          value: "non-redirecting",
        })
      ).toThrow(TypeError);
      expect(driver.migrationNamespaceAttestation).toBeUndefined();
    }
  });

  test("PlanetScale ignores a same-named input property", () => {
    const driver = new PlanetScaleDriver({
      namespace: "alpha",
      ...JSON.parse('{"migrationNamespaceAttestation": "non-redirecting"}'),
    });

    expect(driver.migrationNamespaceAttestation).toBeUndefined();
    expect(driver.adapter.namespace).toBe("alpha");
  });

  test("a trusted custom driver may supply the literal to the base constructor", () => {
    class TrustedMySQLDriver extends Driver<null, null> {
      readonly adapter = new MySQLAdapter("alpha");

      constructor() {
        super("mysql", "trusted-mysql", {}, "non-redirecting");
      }

      protected async initClient(): Promise<null> {
        return null;
      }

      protected async closeClient(): Promise<void> {
        // No provider resource.
      }

      protected async execute<T>(): Promise<QueryResult<T>> {
        return { rows: [], rowCount: 0 };
      }

      protected async executeRaw<T>(): Promise<QueryResult<T>> {
        return this.execute();
      }

      protected async transaction<T>(
        _client: null,
        run: (transaction: null) => Promise<T>
      ): Promise<T> {
        return run(null);
      }
    }

    const driver = new TrustedMySQLDriver();
    expect(driver.migrationNamespaceAttestation).toBe("non-redirecting");
    expect(
      Reflect.set(driver, "migrationNamespaceAttestation", undefined)
    ).toBe(false);
  });
});

// ============================================================
// IMMUTABLE DRIVER FACTS
// ============================================================

describe("the driver's adapter reference cannot be replaced", () => {
  const stock = [
    ["pg", () => new PgDriver({ namespace: "alpha" })],
    ["postgres.js", () => new PostgresDriver({ namespace: "alpha" })],
    ["pglite", () => new PGliteDriver({ namespace: "alpha" })],
    ["neon-http", () => new NeonHTTPDriver({ namespace: "alpha" })],
    ["bun-sql", () => new BunSQLDriver({ namespace: "alpha" })],
    ["mysql2", () => new MySQL2Driver({ namespace: "alpha" })],
    ["planetscale", () => new PlanetScaleDriver({ namespace: "alpha" })],
  ] as const;

  test.each(
    stock
  )("%s refuses assignment and defineProperty", (_name, build) => {
    const driver = build();
    const adapter = driver.adapter;
    const impostor = new PostgresAdapter("victim");

    expect(Reflect.set(driver, "adapter", impostor)).toBe(false);
    expect(() =>
      Object.defineProperty(driver, "adapter", { value: impostor })
    ).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(driver, "adapter", {
        get: () => impostor,
        configurable: true,
      })
    ).toThrow(TypeError);

    expect(driver.adapter).toBe(adapter);
    expect(driver.adapter.namespace).toBe("alpha");
  });

  test("transaction views share the exact adapter and the exact assertion", () => {
    const base = new MySQL2Driver({
      namespace: "alpha",
      migrationNamespaceAttestation: "non-redirecting",
    });
    const transaction = new TransactionBoundDriver(base, null);
    const nested = new TransactionBoundDriver(transaction, null);

    expect(transaction.adapter).toBe(base.adapter);
    expect(nested.adapter).toBe(base.adapter);
    expect(transaction.migrationNamespaceAttestation).toBe("non-redirecting");
    expect(nested.migrationNamespaceAttestation).toBe("non-redirecting");

    expect(Reflect.set(nested, "adapter", new MySQLAdapter("victim"))).toBe(
      false
    );
    expect(
      Reflect.set(nested, "migrationNamespaceAttestation", undefined)
    ).toBe(false);
    expect(nested.adapter).toBe(base.adapter);
    expect(nested.migrationNamespaceAttestation).toBe("non-redirecting");
  });

  test("a transaction view never invents an assertion the base lacks", () => {
    const base = new MySQL2Driver({ namespace: "alpha" });
    const transaction = new TransactionBoundDriver(base, null);

    expect(transaction.migrationNamespaceAttestation).toBeUndefined();
  });
});

describe("the driver's dialect cannot be relabelled", () => {
  // `bindOfficialCacheChain` partitions the official cache on exactly two
  // driver facts: this `dialect` and `adapter.namespace`. The adapter reference
  // and the namespace on it are already installed immutably, so the dialect was
  // the one remaining writable member of that tuple — and a PostgreSQL schema
  // `alpha` and a MySQL database `alpha` spell their qualifier identically, so
  // relabelling the dialect alone is enough to address another store's entries.
  const stock = [
    ["pg", () => new PgDriver({ namespace: "alpha" }), "postgresql"],
    [
      "postgres.js",
      () => new PostgresDriver({ namespace: "alpha" }),
      "postgresql",
    ],
    ["pglite", () => new PGliteDriver({ namespace: "alpha" }), "postgresql"],
    [
      "neon-http",
      () => new NeonHTTPDriver({ namespace: "alpha" }),
      "postgresql",
    ],
    ["bun-sql", () => new BunSQLDriver({ namespace: "alpha" }), "postgresql"],
    ["mysql2", () => new MySQL2Driver({ namespace: "alpha" }), "mysql"],
    [
      "planetscale",
      () => new PlanetScaleDriver({ namespace: "alpha" }),
      "mysql",
    ],
    ["sqlite3", () => new SQLite3Driver(), "sqlite"],
  ] as const;

  test.each(
    stock
  )("%s refuses assignment, deletion, and defineProperty", (_name, build, dialect) => {
    const driver = build();
    const forgery = dialect === "mysql" ? "postgresql" : "mysql";

    expect(driver.dialect).toBe(dialect);
    expect(Reflect.set(driver, "dialect", forgery)).toBe(false);
    expect(Reflect.deleteProperty(driver, "dialect")).toBe(false);
    expect(() =>
      Object.defineProperty(driver, "dialect", { value: forgery })
    ).toThrow(TypeError);
    // An accessor is the same forgery wearing a different descriptor: it
    // answers per read, so a scope bound from an honest value could still be
    // followed by a relabelled render.
    expect(() =>
      Object.defineProperty(driver, "dialect", {
        get: () => forgery,
        configurable: true,
      })
    ).toThrow(TypeError);

    expect(driver.dialect).toBe(dialect);
  });

  test("transaction views carry the base dialect and refuse it too", () => {
    class PostgresCustomDriver extends Driver<null, null> {
      readonly adapter = new PostgresAdapter("alpha");

      constructor() {
        super("postgresql", "custom-postgres");
      }

      protected async initClient(): Promise<null> {
        return null;
      }

      protected async closeClient(): Promise<void> {
        // No provider resource.
      }

      protected async execute<T>(): Promise<QueryResult<T>> {
        return { rows: [], rowCount: 0 };
      }

      protected async executeRaw<T>(): Promise<QueryResult<T>> {
        return this.execute();
      }

      protected async transaction<T>(
        _client: null,
        run: (transaction: null) => Promise<T>
      ): Promise<T> {
        return run(null);
      }
    }

    const base = new PostgresCustomDriver();
    const transaction = new TransactionBoundDriver(base, null);
    const nested = new TransactionBoundDriver(transaction, null);

    // Every view the engine may re-read per statement, not just the root.
    for (const view of [base, transaction, nested]) {
      expect(view.dialect).toBe("postgresql");
      expect(Reflect.set(view, "dialect", "mysql")).toBe(false);
      expect(Reflect.deleteProperty(view, "dialect")).toBe(false);
      expect(() =>
        Object.defineProperty(view, "dialect", { value: "mysql" })
      ).toThrow(TypeError);
      expect(() =>
        Object.defineProperty(view, "dialect", {
          get: () => "mysql",
          configurable: true,
        })
      ).toThrow(TypeError);
      expect(view.dialect).toBe("postgresql");
    }
  });
});

// ============================================================
// WRAPPERS
// ============================================================

describe("convenience wrappers pass the namespace to their driver", () => {
  test.each([
    ["pg", () => createPgClient({ schema, namespace: "alpha" })],
    ["postgres.js", () => createPostgresClient({ schema, namespace: "alpha" })],
    ["pglite", () => createPGliteClient({ schema, namespace: "alpha" })],
    [
      "neon-http",
      () =>
        createNeonClient({
          schema,
          databaseUrl: "postgres://host/db",
          namespace: "alpha",
        }),
    ],
    ["bun-sql", () => createBunSQLClient({ schema, namespace: "alpha" })],
    ["mysql2", () => createMySQL2Client({ schema, namespace: "alpha" })],
    [
      "planetscale",
      () => createPlanetScaleClient({ schema, namespace: "alpha" }),
    ],
  ] as const)("%s", (_name, build) => {
    expect(driverFromWrapper(build).adapter.namespace).toBe("alpha");
  });

  test("PostgreSQL wrappers default to public", () => {
    expect(
      driverFromWrapper(() => createPgClient({ schema })).adapter.namespace
    ).toBe("public");
    expect(
      driverFromWrapper(() =>
        createPGliteClient({ schema, namespace: undefined })
      ).adapter.namespace
    ).toBe("public");
  });

  test("MySQL wrappers stay unbound without a resolvable target", () => {
    expect(
      driverFromWrapper(() => createMySQL2Client({ schema })).adapter.namespace
    ).toBeUndefined();
    expect(
      driverFromWrapper(() => createPlanetScaleClient({ schema })).adapter
        .namespace
    ).toBeUndefined();
  });

  test("the MySQL2 wrapper carries the attestation and only the exact literal", () => {
    expect(
      driverFromWrapper(() =>
        createMySQL2Client({
          schema,
          namespace: "alpha",
          migrationNamespaceAttestation: "non-redirecting",
        })
      ).migrationNamespaceAttestation
    ).toBe("non-redirecting");

    expect(() =>
      createMySQL2Client({
        schema,
        ...JSON.parse('{"migrationNamespaceAttestation": "nonredirecting"}'),
      })
    ).toThrow(ClientInitializationError);
  });

  test.each([
    ["pg", (namespace: string) => createPgClient({ schema, namespace })],
    [
      "postgres.js",
      (namespace: string) => createPostgresClient({ schema, namespace }),
    ],
    [
      "pglite",
      (namespace: string) => createPGliteClient({ schema, namespace }),
    ],
    [
      "neon-http",
      (namespace: string) =>
        createNeonClient({ schema, databaseUrl: "postgres://h/d", namespace }),
    ],
    [
      "bun-sql",
      (namespace: string) => createBunSQLClient({ schema, namespace }),
    ],
  ] as const)("%s refuses a system schema before constructing a client", (_name, build) => {
    const created = vi.spyOn(VibORM, "create");

    expect(() => build("pg_catalog")).toThrow(ClientInitializationError);
    expect(() => build("information_schema")).toThrow(
      ClientInitializationError
    );
    expect(created).not.toHaveBeenCalled();
  });

  test("PlanetScale records a qualifier only from the explicit option", () => {
    const fromUrl = driverFromWrapper(() =>
      createPlanetScaleClient({
        schema,
        databaseUrl: "mysql://user:pw@aws.connect.psdb.cloud/resource_db",
      })
    );
    const fromOptions = driverFromWrapper(() =>
      createPlanetScaleClient({
        schema,
        options: { host: "aws.connect.psdb.cloud", username: "u" },
      })
    );
    const fromClient = driverFromWrapper(() =>
      createPlanetScaleClient({
        schema,
        client: new PlanetScaleClient({ host: "aws.connect.psdb.cloud" }),
      })
    );

    expect(fromUrl.adapter.namespace).toBeUndefined();
    expect(fromOptions.adapter.namespace).toBeUndefined();
    expect(fromClient.adapter.namespace).toBeUndefined();
  });
});

// ============================================================
// CLIENT CONSTRUCTION
// ============================================================

describe("client construction proves the PostgreSQL target", () => {
  class CustomDriver extends Driver<null, null> {
    readonly adapter;

    constructor(
      dialect: "postgresql" | "mysql",
      adapter: SQLiteAdapter | MySQLAdapter | PostgresAdapter
    ) {
      super(dialect, "custom");
      this.adapter = adapter;
    }

    protected async initClient(): Promise<null> {
      return null;
    }

    protected async closeClient(): Promise<void> {
      // No provider resource.
    }

    protected async execute<T>(): Promise<QueryResult<T>> {
      return { rows: [], rowCount: 0 };
    }

    protected async executeRaw<T>(): Promise<QueryResult<T>> {
      return this.execute();
    }

    protected async transaction<T>(
      _client: null,
      run: (transaction: null) => Promise<T>
    ): Promise<T> {
      return run(null);
    }
  }

  test("a custom PostgreSQL adapter without a namespace is refused, not defaulted", () => {
    expect(() =>
      VibORM.create({
        schema,
        driver: new CustomDriver("postgresql", new SQLiteAdapter()),
      })
    ).toThrow(ClientInitializationError);
  });

  test("a custom PostgreSQL adapter with a namespace is admitted", () => {
    expect(() =>
      VibORM.create({
        schema,
        driver: new CustomDriver("postgresql", new PostgresAdapter("alpha")),
      })
    ).not.toThrow();
  });

  test("a custom unbound MySQL adapter stays valid for runtime work", () => {
    expect(() =>
      VibORM.create({
        schema,
        driver: new CustomDriver("mysql", new MySQLAdapter()),
      })
    ).not.toThrow();
  });
});
