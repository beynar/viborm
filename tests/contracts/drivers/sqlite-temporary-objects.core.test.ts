import { getAdapterInternals } from "@adapters/adapter-internals";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { createClient as bunSQLClient } from "@drivers/bun-sql";
import { BunSQLiteDriver } from "@drivers/bun-sqlite";
import { D1Driver } from "@drivers/d1";
import { LibSQLDriver } from "@drivers/libsql";
import { createClient as neonClient } from "@drivers/neon-http";
import { PgDriver, createClient as pgClient } from "@drivers/pg";
import { createClient as pgliteClient } from "@drivers/pglite";
import { createClient as postgresClient } from "@drivers/postgres";
import { SQLite3Driver } from "@drivers/sqlite3";
import { s } from "@schema";
import { sql } from "@sql";
import { describe, expect, test } from "vitest";

const REFUSED_BOUND =
  /"relationsPerStatement" option must be a positive integer/;

const scratchDdl = (adapter: DatabaseAdapter): string[] =>
  getAdapterInternals(adapter)
    .batchRefs.setup("batch-1")
    .map((statement) => statement.toStatement());

const TEMP_SCRATCH =
  'CREATE TEMP TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))';
const MAIN_SCRATCH =
  'CREATE TABLE IF NOT EXISTS "__viborm_batch_refs" ("batch_id" TEXT NOT NULL, "ref_key" TEXT NOT NULL, "ref_value" TEXT, PRIMARY KEY ("batch_id", "ref_key"))';

describe("SQLite transport temporary objects", () => {
  // A local SQLite file must not gain a persistent engine table, so every
  // driver whose transport admits TEMP keeps the scratch there; D1's
  // authorizer refuses temporary objects, so D1 alone spells it in `main`
  // (live witness: tests/providers/workers/d1.test.ts).
  test.each([
    ["sqlite3", new SQLite3Driver(), TEMP_SCRATCH],
    ["libsql", new LibSQLDriver(), TEMP_SCRATCH],
    ["bun-sqlite", new BunSQLiteDriver(), TEMP_SCRATCH],
    ["d1", new D1Driver({ database: Object.create(null) }), MAIN_SCRATCH],
  ])("%s spells the batch reference scratch its transport admits", (_name, driver, ddl) => {
    expect(scratchDdl(driver.adapter)).toEqual([ddl]);
  });
});

const check = (adapter: DatabaseAdapter): string =>
  adapter.subqueries.existsCheck(sql.raw('"t"'), sql.raw("1")).toStatement();

describe("SQLite transport expression depth", () => {
  // SQLite's default SQLITE_MAX_EXPR_DEPTH is 1000; D1 compiles with 100
  // ("Expression tree is too large"), so D1 alone nests relation filters in
  // a derived table (live witness: tests/providers/workers/d1-permissions-verbs.test.ts,
  // W-W3 and W-W7).
  test.each([
    ["sqlite3", new SQLite3Driver(), 'SELECT 1 FROM "t" WHERE 1'],
    ["libsql", new LibSQLDriver(), 'SELECT 1 FROM "t" WHERE 1'],
    ["bun-sqlite", new BunSQLiteDriver(), 'SELECT 1 FROM "t" WHERE 1'],
    [
      "d1",
      new D1Driver({ database: Object.create(null) }),
      'SELECT 1 FROM (SELECT 1 FROM "t" WHERE 1)',
    ],
  ])("%s spells a relation filter for the depth its transport compiles", (_name, driver, spelled) => {
    expect(check(driver.adapter)).toBe(spelled);
  });
});

describe("Shared relation bodies", () => {
  test.each([
    undefined,
    true,
    false,
  ])("every PostgreSQL client factory preserves sharedRelationBodies=%s", (sharedRelationBodies) => {
    const config = {
      schema: { item: s.model({ id: s.string().id() }) },
      sharedRelationBodies,
    };
    const remote = { ...config, databaseUrl: "postgres://h/d" };
    // Construction is lazy: this checks the public configuration boundary
    // without connecting to a provider or loading PGlite's Wasm runtime.
    for (const client of [
      pgClient(remote),
      pgliteClient(config),
      postgresClient(remote),
      neonClient(remote),
      bunSQLClient(remote),
    ]) {
      expect(
        client.$driver.adapter.capabilities.sharesRelationBodies ?? false
      ).toBe(sharedRelationBodies !== false);
    }
  });
  // Neki refuses a statement referencing more than 256 relations; a plain
  // PostgreSQL server bounds none, and a statement escalated to fit pays in
  // its plan, so the bound is the caller's to state.
  test.each([
    undefined,
    256,
  ])("every PostgreSQL client factory preserves relationsPerStatement=%s", (relationsPerStatement) => {
    const config = {
      schema: { item: s.model({ id: s.string().id() }) },
      relationsPerStatement,
    };
    const remote = { ...config, databaseUrl: "postgres://h/d" };
    for (const client of [
      pgClient(remote),
      pgliteClient(config),
      postgresClient(remote),
      neonClient(remote),
      bunSQLClient(remote),
    ]) {
      expect(client.$driver.adapter.capabilities.relationsPerStatement).toBe(
        relationsPerStatement
      );
    }
  });
  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
    "256",
  ])("a PostgreSQL driver refuses relationsPerStatement=%s", (relationsPerStatement) => {
    expect(
      () =>
        new PgDriver({
          databaseUrl: "postgres://h/d",
          relationsPerStatement: relationsPerStatement as number,
        })
    ).toThrow(REFUSED_BOUND);
  });
  // D1 refuses a statement over 100 KB; PlanetScale's Neki one referencing
  // more than 256 relations. D1 declares the fact, and so does every
  // PostgreSQL driver by default (the answers are the same, the statement
  // smaller); `sharedRelationBodies: false` keeps the bodies inline (live
  // witnesses: tests/providers/workers/d1-permissions-placement.test.ts W-P10,
  // Neki W-R1).
  test.each([
    ["sqlite3", new SQLite3Driver(), undefined],
    ["libsql", new LibSQLDriver(), undefined],
    ["bun-sqlite", new BunSQLiteDriver(), undefined],
    ["d1", new D1Driver({ database: Object.create(null) }), true],
    ["pg", new PgDriver({ databaseUrl: "postgres://h/d" }), true],
    [
      "pg, declared",
      new PgDriver({
        databaseUrl: "postgres://h/d",
        sharedRelationBodies: true,
      }),
      true,
    ],
    [
      "pg, inline",
      new PgDriver({
        databaseUrl: "postgres://h/d",
        sharedRelationBodies: false,
      }),
      false,
    ],
  ])("%s shares the relation bodies a statement repeats where its transport bounds the statement", (_name, driver, shared) => {
    expect(driver.adapter.capabilities.sharesRelationBodies ?? false).toBe(
      shared ?? false
    );
  });
});
