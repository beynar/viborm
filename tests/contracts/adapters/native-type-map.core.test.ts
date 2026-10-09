/**
 * Issue #45 — one native-type map, handed to every adapter.
 *
 * The query engine never chooses a dialect: it threads the scalar's
 * declaration through `idRepresentation`, `dateTimeRepresentation` and
 * `literals.dateTime`, and each adapter asks the one resolver for its OWN
 * dialect's entry. So a single declaration produces each dialect's physical
 * promise, and the promise agrees with the column its migration driver creates.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { readArrayLiteralText } from "@adapters/databases/postgres/array-literal";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { s } from "@schema";
import { MYSQL, PG, SQLITE } from "@schema/scalars/native-types";
import { sql } from "@sql";
import type { IdDomain } from "@validation/primitives/id-codec";
import { describe, expect, test } from "vitest";

// Typed as the interface the engine calls them through.
const pg: DatabaseAdapter = new PostgresAdapter();
const mysql: DatabaseAdapter = new MySQLAdapter();
const sqlite: DatabaseAdapter = new SQLiteAdapter();

const uuid: IdDomain = { format: "uuid" };

describe("identifier storage from one map", () => {
  test("each adapter reads its own dialect's entry", () => {
    const declaration = s.string({
      pg: PG.BLOB.BYTEA,
      mysql: MYSQL.STRING.VARCHAR(36),
    })["~"].nativeType;
    expect(pg.result.idRepresentation?.(uuid, declaration)).toBe("bytes");
    expect(mysql.result.idRepresentation?.(uuid, declaration)).toBe("text");
    // SQLite has no entry: its automatic compact column.
    expect(sqlite.result.idRepresentation?.(uuid, declaration)).toBe("bytes");
  });

  test("an entry for the adapter's dialect overrides only that dialect", () => {
    const declaration = s.string({ sqlite: SQLITE.STRING.TEXT })["~"]
      .nativeType;
    expect(pg.result.idRepresentation?.(uuid, declaration)).toBe("uuid");
    expect(mysql.result.idRepresentation?.(uuid, declaration)).toBe("bytes");
    expect(sqlite.result.idRepresentation?.(uuid, declaration)).toBe("text");
  });
});

describe("SQLite DateTime from one map", () => {
  const iso = "2026-01-15T10:30:00.789Z";

  test("the representation and the operand follow the SQLite entry", () => {
    const epoch = s.dateTime({
      pg: PG.DATETIME.TIMESTAMP(3),
      sqlite: SQLITE.DATETIME.INTEGER,
    })["~"].nativeType;
    expect(sqlite.result.dateTimeRepresentation?.(epoch)).toBe("epochMillis");
    expect(sqlite.literals.dateTime(iso, epoch).values).toEqual([
      Date.parse(iso),
    ]);
    const julian = s.dateTime({ sqlite: SQLITE.DATETIME.REAL })["~"].nativeType;
    expect(sqlite.result.dateTimeRepresentation?.(julian)).toBe("julianDay");
  });

  test("a map without a SQLite entry keeps timestamp text", () => {
    const declaration = s.dateTime({ pg: PG.DATETIME.TIMESTAMP(3) })["~"]
      .nativeType;
    expect(sqlite.result.dateTimeRepresentation?.(declaration)).toBe("text");
    expect(sqlite.literals.dateTime(iso, declaration).values).toEqual([iso]);
  });

  test("dialects with a temporal type ignore the SQLite entry", () => {
    const declaration = s.dateTime({ sqlite: SQLITE.DATETIME.INTEGER })["~"]
      .nativeType;
    expect(pg.literals.dateTime(iso, declaration).values).toEqual([iso]);
    expect(mysql.literals.dateTime(iso, declaration).values).toEqual([
      "2026-01-15 10:30:00.789",
    ]);
  });
});

test("PostgreSQL native strings preserve equality and lower text predicates explicitly", () => {
  const column = sql.raw`value`;
  for (const type of [PG.STRING.CITEXT, PG.STRING.XML, PG.STRING.UUID]) {
    const native = s.string({ pg: type })["~"].nativeType;
    expect(
      pg.expressions.caseSensitiveText(column, native, true).toStatement()
    ).toBe(type === PG.STRING.CITEXT ? "value" : "CAST(value AS TEXT)");
    if (type === PG.STRING.XML) {
      expect(() => pg.expressions.caseSensitiveText(column, native)).toThrow(
        "XML has no equality"
      );
    } else {
      expect(pg.expressions.caseSensitiveText(column, native)).toBe(column);
    }
  }
  expect(pg.expressions.caseSensitiveText(column, undefined, true)).toBe(
    column
  );
});

test("PostgreSQL array transport distinguishes nulls, quoted values and escapes", () => {
  expect(readArrayLiteralText("{}")).toEqual([]);
  expect(
    readArrayLiteralText(String.raw`{NULL,"NULL","",42,"a,b","a\\b","a\"b"}`)
  ).toEqual([null, "NULL", "", "42", "a,b", "a\\b", 'a"b']);
  for (const malformed of [
    "[]",
    "{a",
    "{{a}}",
    '{a"b}',
    "{a}b}",
    '{"open}',
    '{"closed"x}',
    "{a,}",
    String.raw`{a\}`,
  ]) {
    expect(readArrayLiteralText(malformed)).toBeUndefined();
  }
});
