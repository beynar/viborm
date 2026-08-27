/**
 * The adapter-owned namespace fact.
 *
 * One value per adapter, chosen at construction, installed so it cannot be
 * replaced afterwards. `viborm/adapters` is a public export, so the two
 * constructors and the three exported instances are contract, not plumbing.
 *
 * Qualified table rendering is Unit B's; what is proven here is which value
 * each adapter holds and that the value reaches the dialect's identifier
 * quoter unchanged.
 */

import { installAdapterNamespace } from "@adapters/adapter-namespace";
import {
  MySQLAdapter,
  mysqlAdapter,
} from "@adapters/databases/mysql/mysql-adapter";
import {
  PostgresAdapter,
  postgresAdapter,
} from "@adapters/databases/postgres/postgres-adapter";
import {
  SQLiteAdapter,
  sqliteAdapter,
} from "@adapters/databases/sqlite/sqlite-adapter";
import { BunSQLDriver } from "@drivers/bun-sql";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import { ClientInitializationError, FeatureNotSupportedError } from "@errors";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

describe("PostgreSQL adapter namespace", () => {
  test("an omitted, explicitly undefined, and exported adapter all mean public", () => {
    expect(new PostgresAdapter().namespace).toBe("public");
    expect(new PostgresAdapter(undefined).namespace).toBe("public");
    expect(postgresAdapter.namespace).toBe("public");
  });

  test("an explicit schema is the adapter's namespace", () => {
    expect(new PostgresAdapter("alpha").namespace).toBe("alpha");
    expect(new PostgresAdapter("Alpha").namespace).toBe("Alpha");
  });

  test("the namespace reaches the dialect quoter as one identifier", () => {
    const quote = (adapter: PostgresAdapter): string =>
      adapter.identifiers.escape(adapter.namespace).toStatement();

    expect(quote(new PostgresAdapter())).toBe('"public"');
    expect(quote(postgresAdapter)).toBe('"public"');
    expect(quote(new PostgresAdapter("alpha"))).toBe('"alpha"');
  });

  test.each([
    ["a system schema", "pg_catalog"],
    ["the information schema", "information_schema"],
    ["a dotted name", "alpha.beta"],
    ["an empty name", ""],
    ["a 64-character name", "a".repeat(64)],
    ["a quote character", 'al"pha'],
  ])("refuses %s at construction", (_label, namespace) => {
    expect(() => new PostgresAdapter(namespace)).toThrow(
      ClientInitializationError
    );
  });

  test("admits a keyword and the 63-character boundary", () => {
    expect(new PostgresAdapter("select").namespace).toBe("select");
    expect(new PostgresAdapter("a".repeat(63)).namespace).toBe("a".repeat(63));
  });
});

describe("MySQL adapter namespace", () => {
  test("an omitted, explicitly undefined, and exported adapter stay unbound", () => {
    expect(new MySQLAdapter().namespace).toBeUndefined();
    expect(new MySQLAdapter(undefined).namespace).toBeUndefined();
    expect(mysqlAdapter.namespace).toBeUndefined();
  });

  test("an explicit database is the adapter's namespace", () => {
    const adapter = new MySQLAdapter("alpha");
    expect(adapter.namespace).toBe("alpha");
    expect(adapter.identifiers.escape("alpha").toStatement()).toBe("`alpha`");
  });

  test.each([
    "mysql",
    "SYS",
    "performance_schema",
    "@primary",
    "@replica",
  ])("refuses %s at construction", (namespace) => {
    expect(() => new MySQLAdapter(namespace)).toThrow(
      ClientInitializationError
    );
  });

  test("admits the 64-character boundary", () => {
    expect(new MySQLAdapter("a".repeat(64)).namespace).toBe("a".repeat(64));
  });
});

describe("SQLite adapters have no namespace", () => {
  test("the property is absent, not undefined-valued", () => {
    expect("namespace" in sqliteAdapter).toBe(false);
    expect("namespace" in new SQLiteAdapter()).toBe(false);
  });
});

describe("no alias spelling exists", () => {
  test.each([
    ["postgres", postgresAdapter],
    ["mysql", mysqlAdapter],
    ["sqlite", sqliteAdapter],
  ])("%s exposes no databaseNamespace", (_label, adapter) => {
    expect("databaseNamespace" in adapter).toBe(false);
    expect("databaseSchema" in adapter).toBe(false);
    expect("keyspace" in adapter).toBe(false);
  });
});

describe("the installed namespace cannot be replaced", () => {
  test("assignment fails and leaves the value and its rendering unchanged", () => {
    const adapter = new PostgresAdapter("alpha");

    expect(Reflect.set(adapter, "namespace", "victim")).toBe(false);

    expect(adapter.namespace).toBe("alpha");
    expect(adapter.identifiers.escape(adapter.namespace).toStatement()).toBe(
      '"alpha"'
    );
  });

  test("defineProperty fails and leaves the value unchanged", () => {
    const adapter = new MySQLAdapter("alpha");

    expect(() =>
      Object.defineProperty(adapter, "namespace", { value: "victim" })
    ).toThrow(TypeError);
    expect(() =>
      Object.defineProperty(adapter, "namespace", {
        get: () => "victim",
        configurable: true,
      })
    ).toThrow(TypeError);

    expect(adapter.namespace).toBe("alpha");
  });

  test("deletion fails", () => {
    const adapter = new PostgresAdapter("alpha");
    expect(Reflect.deleteProperty(adapter, "namespace")).toBe(false);
    expect(adapter.namespace).toBe("alpha");
  });

  test("the descriptor is an own, non-writable, non-configurable value", () => {
    expect(
      Object.getOwnPropertyDescriptor(new PostgresAdapter("alpha"), "namespace")
    ).toEqual({
      value: "alpha",
      writable: false,
      enumerable: true,
      configurable: false,
    });
  });

  test("an unbound MySQL adapter's absence is installed too", () => {
    const adapter = new MySQLAdapter();
    expect(() =>
      Object.defineProperty(adapter, "namespace", { value: "victim" })
    ).toThrow(TypeError);
    expect(adapter.namespace).toBeUndefined();
  });

  test("a second install on the same object is refused", () => {
    const adapter = new PostgresAdapter("alpha");
    expect(() =>
      installAdapterNamespace(adapter, "victim", "postgresql")
    ).toThrow(TypeError);
    expect(adapter.namespace).toBe("alpha");
  });
});

describe("geospatial capability", () => {
  test("stock adapters declare it explicitly", () => {
    expect(new PostgresAdapter().capabilities.supportsGeospatial).toBe(false);
    expect(new MySQLAdapter().capabilities.supportsGeospatial).toBe(false);
    expect(new SQLiteAdapter().capabilities.supportsGeospatial).toBe(false);
  });

  test.each([
    ["pg", PgDriver],
    ["postgres.js", PostgresDriver],
    ["pglite", PGliteDriver],
    ["neon-http", NeonHTTPDriver],
    ["bun-sql", BunSQLDriver],
  ])("%s reports geospatial support only when postgis is enabled", (_name, Driver) => {
    expect(
      new Driver({ postgis: true }).adapter.capabilities.supportsGeospatial
    ).toBe(true);
    expect(new Driver().adapter.capabilities.supportsGeospatial).toBe(false);
    expect(
      new Driver({ postgis: false }).adapter.capabilities.supportsGeospatial
    ).toBe(false);
  });

  test("the flag agrees with the replaced geospatial member", () => {
    const off = new PgDriver({ postgis: false }).adapter;
    expect(off.capabilities.supportsGeospatial).toBe(false);
    expect(() => off.geospatial.point(sql`1`, sql`2`)).toThrow(
      FeatureNotSupportedError
    );

    const on = new PgDriver({ postgis: true }).adapter;
    expect(on.capabilities.supportsGeospatial).toBe(true);
    expect(() => on.geospatial.point(sql`1`, sql`2`)).not.toThrow();
  });
});
