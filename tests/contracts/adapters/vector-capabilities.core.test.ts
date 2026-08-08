import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { BunSQLDriver } from "@drivers/bun-sql";
import { NeonHTTPDriver } from "@drivers/neon-http";
import { PgDriver } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import { FeatureNotSupportedError } from "@errors";
import { sql } from "@sql";

describe("vector capability matrix", () => {
  test.each([
    ["pg", PgDriver],
    ["postgres.js", PostgresDriver],
    ["pglite", PGliteDriver],
    ["neon-http", NeonHTTPDriver],
    ["bun-sql", BunSQLDriver],
  ])("%s driver reports vector support only when pgvector is enabled", (_name, Driver) => {
    expect(
      new Driver({ pgvector: true }).adapter.capabilities.supportsVector
    ).toBe(true);
    expect(new Driver().adapter.capabilities.supportsVector).toBe(false);
    expect(
      new Driver({ pgvector: false }).adapter.capabilities.supportsVector
    ).toBe(false);
  });

  test("mysql and sqlite adapters do not report vector support", () => {
    expect(new MySQLAdapter().capabilities.supportsVector).toBe(false);
    expect(new SQLiteAdapter().capabilities.supportsVector).toBe(false);
  });

  // Fail-closed on a PostgreSQL driver with pgvector OFF must be asserted on PG
  // itself (not only SQLite): the vector namespace is swapped to a throwing stub
  // in tandem with the capability flag, so a future default-flip that keeps the
  // flag true but forgets the swap (or vice versa) is caught here.
  test("pgvector-off PostgreSQL adapter fails closed on vector operations", () => {
    const off = new PgDriver({ pgvector: false }).adapter;
    expect(off.capabilities.supportsVector).toBe(false);
    expect(() => off.vector.l2(sql`col`, sql`vec`)).toThrow(
      FeatureNotSupportedError
    );
    expect(() => off.vector.cosine(sql`col`, sql`vec`)).toThrow(
      FeatureNotSupportedError
    );
    expect(() => off.vector.literal([1, 2, 3])).toThrow(
      FeatureNotSupportedError
    );

    const on = new PgDriver({ pgvector: true }).adapter;
    expect(() => on.vector.l2(sql`col`, sql`vec`)).not.toThrow();
  });
});
