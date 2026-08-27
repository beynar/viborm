/**
 * What the official cache scope is a function OF.
 *
 * One `cache()` definition and one backend may be shared by several clients, so
 * the thing that keeps two of them from reading each other's rows is the scope
 * derived when the definition binds to a concrete driver. It partitions on four
 * facts — the private snapshot revision, the user's `version`, the dialect, and
 * the adapter's SQL namespace — and the derivation is a PURE function of them.
 *
 * That purity is load-bearing twice over. It is why appending another extension
 * re-derives the same scope instead of needing a registry to hand the old one
 * back, and it is why the assertions below can pin the exact bytes: a scope that
 * were allocated per bind would still have to encode these four facts injectively,
 * and a non-injective join is the one defect no behavioral test would catch
 * (two different clients would simply share entries and look correct).
 *
 * The end-to-end proof that these bytes ARE the storage keys lives beside this
 * file in `namespace-isolation.core.test.ts`.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  createOfficialCacheNamespace,
  type OfficialCacheScopeFacts,
} from "@cache/key";
import {
  createClient as createMySQL2Client,
  MySQL2Driver,
} from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { PlanetScaleDriver } from "@drivers/planetscale";
import { SQLite3Driver } from "@drivers/sqlite3";
import { Client as PlanetScaleClient } from "@planetscale/database";
import { s } from "@schema";
import { afterEach, describe, expect, test, vi } from "vitest";

vi.mock("mysql2/promise", () => ({
  createPool: () => ({ end: () => Promise.resolve() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

const PG = "0070006f0073007400670072006500730071006c";
const MYSQL = "006d007900730071006c";
const SQLITE = "00730071006c006900740065";

/**
 * The exact namespace for each cell of dialect × SQL namespace × version.
 *
 * Read the grammar off the strings: `viborm:cache:<revision>:d:<hex>:<ns>:<ver>`
 * where `<ns>` is `x` (unknown) or `k:<hex>`, and `<ver>` is `u`, `n:<f64 hex>`,
 * or `s:<hex>`. Every body is fixed-width hex and hex never contains the `:`
 * separator, so no component can absorb the one after it.
 *
 * The revision is `r2`: it moved off `r1` because dialect and namespace entered
 * the derivation, and an `r1` entry made no claim about which schema produced
 * its rows.
 */
const ENCODING_TABLE: ReadonlyArray<
  readonly [OfficialCacheScopeFacts, string]
> = [
  [
    { dialect: "postgresql", namespace: "public", version: undefined },
    `viborm:cache:r2:d:${PG}:k:007000750062006c00690063:u`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: "v1" },
    `viborm:cache:r2:d:${PG}:k:007000750062006c00690063:s:00760031`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: 1 },
    `viborm:cache:r2:d:${PG}:k:007000750062006c00690063:n:3ff0000000000000`,
  ],
  [
    { dialect: "postgresql", namespace: "public", version: 0 },
    `viborm:cache:r2:d:${PG}:k:007000750062006c00690063:n:0000000000000000`,
  ],
  [
    { dialect: "postgresql", namespace: "billing", version: undefined },
    `viborm:cache:r2:d:${PG}:k:00620069006c006c0069006e0067:u`,
  ],
  [
    { dialect: "postgresql", namespace: "alpha", version: undefined },
    `viborm:cache:r2:d:${PG}:k:0061006c007000680061:u`,
  ],
  [
    { dialect: "postgresql", namespace: "beta", version: undefined },
    `viborm:cache:r2:d:${PG}:k:0062006500740061:u`,
  ],
  [
    { dialect: "mysql", namespace: "billing", version: undefined },
    `viborm:cache:r2:d:${MYSQL}:k:00620069006c006c0069006e0067:u`,
  ],
  // Unbound MySQL and SQLite: a bare `x`, with no body a string could reach.
  [
    { dialect: "mysql", namespace: undefined, version: undefined },
    `viborm:cache:r2:d:${MYSQL}:x:u`,
  ],
  [
    { dialect: "sqlite", namespace: undefined, version: undefined },
    `viborm:cache:r2:d:${SQLITE}:x:u`,
  ],
  // A database actually NAMED like the absence markers still encodes as known.
  [
    { dialect: "mysql", namespace: "undefined", version: undefined },
    `viborm:cache:r2:d:${MYSQL}:k:0075006e0064006500660069006e00650064:u`,
  ],
  [
    { dialect: "mysql", namespace: "x", version: undefined },
    `viborm:cache:r2:d:${MYSQL}:k:0078:u`,
  ],
];

describe("the encoding table", () => {
  test.each(
    ENCODING_TABLE
  )("derives the exact namespace for %j", (facts, expected) => {
    expect(createOfficialCacheNamespace(facts)).toBe(expected);
  });

  test("derives the same bytes from a held frozen fact object", () => {
    // Fresh literal above, held object here: the derivation reads values, not
    // the shape of the expression that produced them.
    for (const [facts, expected] of ENCODING_TABLE) {
      const held = Object.freeze({ ...facts });
      expect(createOfficialCacheNamespace(held)).toBe(expected);
    }
  });

  test("every cell is distinct", () => {
    const namespaces = ENCODING_TABLE.map(([facts]) =>
      createOfficialCacheNamespace(facts)
    );
    expect(new Set(namespaces).size).toBe(namespaces.length);
  });

  test("carries the r2 revision and never an r1 spelling", () => {
    for (const [facts] of ENCODING_TABLE) {
      const namespace = createOfficialCacheNamespace(facts);
      expect(namespace.startsWith("viborm:cache:r2:")).toBe(true);
      expect(namespace).not.toContain("viborm:cache:r1");
    }
  });
});

describe("the join cannot be forged", () => {
  test("a namespace cannot absorb the version component", () => {
    // If the components were joined without fixed-width encoding, a namespace
    // ending in the next component's text could impersonate a different tuple.
    const absorbing = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: "shop:u",
      version: undefined,
    });
    const absorbed = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: "shop",
      version: undefined,
    });
    expect(absorbing).not.toBe(absorbed);
  });

  test("a dialect cannot absorb the namespace component", () => {
    expect(
      createOfficialCacheNamespace({
        dialect: "mysql:k:0061",
        namespace: undefined,
        version: undefined,
      })
    ).not.toBe(
      createOfficialCacheNamespace({
        dialect: "mysql",
        namespace: "a",
        version: undefined,
      })
    );
  });

  test("the same qualifier in two dialects is two scopes", () => {
    // A PostgreSQL schema `billing` and a MySQL database `billing` are
    // different stores that spell their qualifier identically.
    expect(
      createOfficialCacheNamespace({
        dialect: "postgresql",
        namespace: "billing",
        version: undefined,
      })
    ).not.toBe(
      createOfficialCacheNamespace({
        dialect: "mysql",
        namespace: "billing",
        version: undefined,
      })
    );
  });

  test("an unknown namespace cannot collide with a real one", () => {
    const unknown = createOfficialCacheNamespace({
      dialect: "mysql",
      namespace: undefined,
      version: undefined,
    });
    for (const spelling of ["undefined", "x", "", "null", "*"]) {
      expect(
        createOfficialCacheNamespace({
          dialect: "mysql",
          namespace: spelling,
          version: undefined,
        })
      ).not.toBe(unknown);
    }
  });
});

/**
 * The same derivation over the facts REAL drivers install, so the table above
 * is not asserting about a shape no driver produces.
 */
describe("scopes derived from real driver facts", () => {
  const scopeOf = (
    target: {
      readonly dialect: string;
      readonly adapter: { namespace?: string };
    },
    version?: string | number
  ) =>
    createOfficialCacheNamespace({
      version,
      dialect: target.dialect,
      namespace: target.adapter.namespace,
    });

  test("omitted and explicit PostgreSQL public are one scope", () => {
    const omitted = new PGliteDriver();
    const explicit = new PGliteDriver({ namespace: "public" });
    expect(omitted.adapter.namespace).toBe("public");
    expect(scopeOf(omitted)).toBe(scopeOf(explicit));
  });

  test("five clients over one definition get four scopes", () => {
    // §10: PostgreSQL alpha, PostgreSQL billing, MySQL billing, omitted-public
    // and explicit-public — each distinct dialect/namespace its own scope, and
    // the two public clients one scope.
    const pgAlpha = scopeOf(new PGliteDriver({ namespace: "alpha" }));
    const pgBilling = scopeOf(new PGliteDriver({ namespace: "billing" }));
    const mysqlBilling = scopeOf(
      new MySQL2Driver({
        namespace: "billing",
        options: { host: "127.0.0.1" },
      })
    );
    const pgOmitted = scopeOf(new PGliteDriver());
    const pgExplicit = scopeOf(new PGliteDriver({ namespace: "public" }));

    expect(pgOmitted).toBe(pgExplicit);
    expect(new Set([pgAlpha, pgBilling, mysqlBilling, pgOmitted]).size).toBe(4);
  });

  test("bound and unbound MySQL cannot share a scope", () => {
    const bound = new MySQL2Driver({
      namespace: "app",
      options: { host: "127.0.0.1" },
    });
    const unbound = new MySQL2Driver({ options: { host: "127.0.0.1" } });
    expect(bound.adapter.namespace).toBe("app");
    expect(unbound.adapter.namespace).toBeUndefined();
    expect(scopeOf(bound)).not.toBe(scopeOf(unbound));
    expect(scopeOf(unbound)).toContain(":x:");
  });

  test("SQLite has no namespace property and still derives one honest scope", () => {
    const sqlite = new SQLite3Driver({ dataDir: ":memory:" });
    expect("namespace" in sqlite.adapter).toBe(false);
    expect(scopeOf(sqlite)).toBe(
      createOfficialCacheNamespace({
        dialect: "sqlite",
        namespace: undefined,
        version: undefined,
      })
    );
  });

  test("PlanetScale keyspaces are logical scopes, not routed backends", () => {
    const client = new PlanetScaleClient({ url: "mysql://u:p@host/db" });
    const alpha = new PlanetScaleDriver({ client, namespace: "alpha" });
    const alphaAgain = new PlanetScaleDriver({ client, namespace: "alpha" });
    const beta = new PlanetScaleDriver({ client, namespace: "beta" });
    const routed = new PlanetScaleDriver({ client });

    // Equal qualifiers share a scope; distinct qualifiers stay separated; and
    // an omitted qualifier — VTGate routing, which VibORM does not model — is
    // its own unknown scope rather than any keyspace's.
    expect(scopeOf(alpha)).toBe(scopeOf(alphaAgain));
    expect(scopeOf(alpha)).not.toBe(scopeOf(beta));
    expect(scopeOf(routed)).not.toBe(scopeOf(alpha));
    expect(scopeOf(routed)).not.toBe(scopeOf(beta));

    // A routing-rule transition is partitioned by the user's version bump, the
    // only lever the extension offers for it.
    expect(scopeOf(alpha, "before")).not.toBe(scopeOf(alpha, "after"));
  });

  test("adapters constructed directly agree with the drivers that carry them", () => {
    expect(new PostgresAdapter().namespace).toBe("public");
    expect(new PostgresAdapter("billing").namespace).toBe("billing");
    expect(new MySQLAdapter("billing").namespace).toBe("billing");
    expect(new MySQLAdapter().namespace).toBeUndefined();
    expect("namespace" in new SQLiteAdapter()).toBe(false);
  });

  test("no connection string, host, or credential reaches the scope", () => {
    const user = s.model({ id: s.string().id() });
    const client = createMySQL2Client({
      schema: { user },
      databaseUrl: "mysql://secret_user:secret_pass@secret.host:3306/app",
    });
    const namespace = createOfficialCacheNamespace({
      version: "secret-free",
      dialect: client.$driver.dialect,
      namespace: client.$driver.adapter.namespace,
    });
    for (const secret of [
      "secret_user",
      "secret_pass",
      "secret.host",
      "3306",
    ]) {
      expect(namespace).not.toContain(secret);
    }
    // Only the database name — which IS the namespace — survives.
    expect(client.$driver.adapter.namespace).toBe("app");
  });
});
