/**
 * A decimal relation key uses the referenced column's exact write lowering.
 *
 * The adjacent extended contract proves the link against PGlite and SQLite3.
 * This deterministic half freezes the SQL invariant for all three dialects.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { buildScalarSqlValue } from "@query-engine/builders/values-builder";
import { createQueryScope } from "@query-engine/context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { sql } from "@sql";
import { referenceSql } from "@src/query-engine/write-engine/fragment-builders";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import Decimal from "decimal.js";
import { beforeAll, describe, expect, test } from "vitest";

const MONEY = Object.freeze({ precision: 16, scale: 2 });
const BIG30 = "90071992547409.93";
const HALF = "9.5";
const HALF_UNCANONICAL = "9.50";

const vault = s
  .model({
    key: s.decimal(MONEY).id(),
    label: s.string(),
    slips: s.toMany(() => slip),
  })
  .map("decimal_relkey_vaults");

const slip = s
  .model({
    id: s.string().id(),
    note: s.string(),
    vaultKey: s.decimal(MONEY),
    vault: s.toOne(() => vault).fields("vaultKey").references("key"),
  })
  .map("decimal_relkey_slips");

const gauge = s
  .model({
    id: s.string().id(),
    readingRef: s.number(),
  })
  .map("decimal_relkey_gauges");

const schema = { vault, slip };

interface SqlDialectCase {
  readonly name: string;
  readonly dialect: Dialect;
  readonly adapter: () => DatabaseAdapter;
  readonly forbidden: string[];
  readonly deferredDomain: string;
}

const sqlDialects: SqlDialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    adapter: () => new PostgresAdapter(),
    forbidden: [],
    deferredDomain: "NUMERIC(16,2)",
  },
  {
    name: "MySQL",
    dialect: "mysql",
    adapter: () => new MySQLAdapter(),
    forbidden: ["AS DECIMAL)", "DECIMAL(65,30)"],
    deferredDomain: "DECIMAL(16,2)",
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    adapter: () => new SQLiteAdapter(),
    forbidden: ["AS NUMERIC)", "AS REAL)"],
    deferredDomain: "INTEGER",
  },
];

beforeAll(() => hydrateSchemaNames(schema));

const rendered = (fragment: ReturnType<typeof referenceSql>) => ({
  statement: fragment.toStatement("$n"),
  values: fragment.values,
});

describe.each(sqlDialects)("$name decimal FK lowering", (dialectCase) => {
  const engineFor = () => {
    const adapter = dialectCase.adapter();
    const registry = createModelRegistry(schema, createSchemaRegistry(schema));
    return new QueryEngine(
      new SqlOnlyDriver(adapter, dialectCase.dialect),
      registry
    );
  };

  const referencedColumnLowering = (
    engine: QueryEngine,
    value: unknown
  ): { statement: string; values: unknown[] } => {
    const scope = createQueryScope(engine, vault);
    return rendered(buildScalarSqlValue(scope, vault, "key", value));
  };

  for (const value of [BIG30, HALF, HALF_UNCANONICAL, 9.5, new Decimal(12)]) {
    test(`FK lowering of ${String(value)} equals the referenced column's`, () => {
      const engine = engineFor();
      const fk = rendered(referenceSql(engine, slip, "vaultKey", value));

      expect(fk).toEqual(referencedColumnLowering(engine, value));
    });
  }

  test("the FK never wears a lossy decimal cast", () => {
    const engine = engineFor();
    const fk = rendered(referenceSql(engine, slip, "vaultKey", BIG30));

    for (const spelling of dialectCase.forbidden) {
      expect(fk.statement).not.toContain(spelling);
    }
    const uncanonical = rendered(
      referenceSql(engine, slip, "vaultKey", HALF_UNCANONICAL)
    );
    expect(uncanonical.values).toEqual(
      referencedColumnLowering(engine, HALF).values
    );
    expect(uncanonical.values).not.toContain(HALF_UNCANONICAL);
  });

  test("a deferred FK expression takes the exact-decimal cast", () => {
    const engine = engineFor();
    const deferred = rendered(
      referenceSql(engine, slip, "vaultKey", sql.raw`captured_key`)
    );

    for (const spelling of dialectCase.forbidden) {
      expect(deferred.statement).not.toContain(spelling);
    }
    expect(deferred.statement).toContain("captured_key");
    expect(deferred.statement).toContain(dialectCase.deferredDomain);
  });

  test("an approximate column keeps the numeric cast", () => {
    const engine = engineFor();
    const numberFk = rendered(referenceSql(engine, gauge, "readingRef", 1.5));

    expect(numberFk.statement).toContain("CAST(");
    expect(numberFk.values).toEqual([1.5]);
  });
});
