import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { describe, expect, test } from "vitest";

describe("adapter default-row inserts", () => {
  test("PostgreSQL exposes only plain DEFAULT VALUES", () => {
    const adapter = new PostgresAdapter();
    const table = adapter.identifiers.escape("events");

    const statement = adapter.mutations.insertDefault(table).toStatement("$n");
    expect(statement).toBe('INSERT INTO "events" DEFAULT VALUES');
    expect(statement).not.toContain("ON CONFLICT");
  });

  test("SQLite exposes only plain DEFAULT VALUES", () => {
    const adapter = new SQLiteAdapter();
    const table = adapter.identifiers.escape("events");

    const statement = adapter.mutations.insertDefault(table).toStatement();
    expect(statement).toBe('INSERT INTO "events" DEFAULT VALUES');
    expect(statement).not.toContain("IGNORE");
  });

  test("MySQL exposes only its plain empty-column row syntax", () => {
    const adapter = new MySQLAdapter();
    const table = adapter.identifiers.escape("events");

    const statement = adapter.mutations.insertDefault(table).toStatement();
    expect(statement).toBe("INSERT INTO `events` () VALUES ()");
    expect(statement).not.toContain("ON DUPLICATE KEY");
  });
});
