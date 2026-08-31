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

describe("scopes derived from concrete driver facts", () => {
  test("omitted and explicit PostgreSQL public are one scope", () => {
    const omitted = new PGliteDriver();
    const explicit = new PGliteDriver({ namespace: "public" });
    expect(omitted.adapter.namespace).toBe("public");
    expect(scopeOf(omitted)).toBe(scopeOf(explicit));
  });

  test("five clients over one definition get four scopes", () => {
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

    expect(scopeOf(alpha)).toBe(scopeOf(alphaAgain));
    expect(scopeOf(alpha)).not.toBe(scopeOf(beta));
    expect(scopeOf(routed)).not.toBe(scopeOf(alpha));
    expect(scopeOf(routed)).not.toBe(scopeOf(beta));
    expect(scopeOf(alpha, "before")).not.toBe(scopeOf(alpha, "after"));
  });

  test("no connection secret reaches the scope", () => {
    const user = s.model({ id: s.string().id() });
    const client = createMySQL2Client({
      schema: { user },
      databaseUrl: "mysql://secret_user:secret_pass@secret.host:3306/app",
    });
    const facts: OfficialCacheScopeFacts = {
      version: "secret-free",
      dialect: client.$driver.dialect,
      namespace: client.$driver.adapter.namespace,
    };
    const namespace = createOfficialCacheNamespace(facts);
    for (const secret of [
      "secret_user",
      "secret_pass",
      "secret.host",
      "3306",
    ]) {
      expect(namespace).not.toContain(secret);
    }
    expect(client.$driver.adapter.namespace).toBe("app");
  });
});
