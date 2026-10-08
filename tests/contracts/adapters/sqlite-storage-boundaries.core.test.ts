import {
  sqliteConstraintClauses,
  sqliteTableDefinitions,
} from "@adapters/databases/sqlite/storage/column-constraints";
import {
  type DecimalStorageKind,
  readSqliteDecimalConstraint,
  sqliteColumnDefinitionCarriesDecimalDescriptor,
  sqliteDecimalCheck,
  sqliteDecimalCopyExpression,
} from "@adapters/databases/sqlite/storage/decimal";
import {
  readSqliteGeoPointColumn,
  SQLITE_GEO_POINT_TYPE,
  sqliteGeoPointCheck,
} from "@adapters/databases/sqlite/storage/geo-point";
import { sqliteStorageCheck } from "@adapters/databases/sqlite/storage/runtime-check";
import {
  readSqliteIdentifier,
  skipSqlNonStructuralRegion,
} from "@adapters/databases/sqlite/storage/sql-lexing";
import { createIdentifierQuoter } from "@src/sql/identifiers";
import type { DecimalDescriptor } from "@validation/primitives/decimal-codec";
import Database from "better-sqlite3";
import { expect, test } from "vitest";

test("catalog admission refuses missing tables and incomplete column records", () => {
  const check = sqliteStorageCheck("events", [
    { name: "at", kind: "timestamp", list: false },
  ]);
  expect(() => check.validate([])).toThrow("physical table is missing");
  expect(() => sqliteStorageCheck("events", []).validate([])).toThrow(
    "physical table is missing"
  );
  const row = {
    definition: "CREATE TABLE events (at TEXT)",
    name: "at",
    type: "TEXT",
  };
  for (const rows of [
    [{ ...row, name: "other" }],
    [{ ...row, type: null }],
    [
      { ...row, name: "other" },
      { ...row, definition: null },
    ],
  ]) {
    expect(() => check.validate(rows)).toThrow("physical column is missing");
  }
  expect(check.validate([row]).values).toEqual(["events", row.definition]);
  expect(check.validate([{ ...row, foreign_time: null }]).values).toEqual([
    "events",
    row.definition,
  ]);
});

test("stored DDL parsing distinguishes empty, quoted and incomplete tokens", () => {
  expect(sqliteTableDefinitions("CREATE TABLE missing")).toEqual([]);
  expect(sqliteTableDefinitions("CREATE TABLE empty ()")).toEqual([
    { text: "", columnName: undefined },
  ]);
  expect(sqliteConstraintClauses("value TEXT CONSTRAINT")).toEqual([]);
  expect(readSqliteIdentifier('  /* comment */ -- line\n "a""b"', 0)).toEqual({
    value: 'a"b',
    quoted: true,
    end: 31,
  });
  expect(readSqliteIdentifier('"unterminated', 0)).toBeUndefined();
  expect(readSqliteIdentifier("  ", 0)).toBeUndefined();
  expect(skipSqlNonStructuralRegion("", 0)).toBe(0);
  expect(skipSqlNonStructuralRegion("-- end", 0)).toBe(6);
  expect(skipSqlNonStructuralRegion("/* end", 0)).toBe(6);
});

test("GeoPoint proof belongs to its column and its exact reserved constraint", () => {
  const quote = createIdentifierQuoter('"');
  const column = { name: "point", type: SQLITE_GEO_POINT_TYPE, nullable: true };
  const ddl = `CREATE TABLE places (
    unrelated TEXT,
    point ${SQLITE_GEO_POINT_TYPE} CONSTRAINT custom CHECK (1)
      ${sqliteGeoPointCheck(column, quote)}
  )`;
  expect(readSqliteGeoPointColumn(ddl, column, quote)).toBe("binary64");
  expect(() => readSqliteGeoPointColumn(null, column, quote)).toThrow(
    "without the exact canonical"
  );
});

test("decimal catalog proof uses primary-key nullability and list storage", () => {
  const quote = createIdentifierQuoter('"');
  const descriptor = { precision: 6, scale: 2 };
  const amount = { name: "amount", type: "INTEGER", nullable: false };
  const values = { name: "values", type: "TEXT", nullable: true };
  const ddl = `CREATE TABLE records (
    amount INTEGER PRIMARY KEY CONSTRAINT custom CHECK (1)
      ${sqliteDecimalCheck(amount, descriptor, "scalar", quote)},
    "values" TEXT ${sqliteDecimalCheck(values, descriptor, "list", quote)}
  )`;
  const db = new Database(":memory:");
  try {
    db.exec(ddl);
    const check = sqliteStorageCheck("records", [
      { name: "amount", kind: "decimal", descriptor, list: false },
      { name: "values", kind: "decimal", descriptor, list: true },
    ]);
    const rows = db
      .prepare<[string], Record<string, unknown>>(check.statement.toStatement())
      .all("records");
    expect(rows.find((row) => row.name === "amount")).toMatchObject({
      pk: 1,
      notnull: 0,
    });
    const guard = check.validate(rows);
    expect(sqliteColumnDefinitionCarriesDecimalDescriptor(ddl, "amount")).toBe(
      true
    );
    expect(db.prepare(guard.toStatement()).get(...guard.values)).toEqual({
      1: 1,
    });
    expect(readSqliteDecimalConstraint(null, amount, quote)).toBeUndefined();
    expect(() =>
      readSqliteDecimalConstraint(
        "CREATE TABLE records (amount INTEGER, CONSTRAINT viborm_decimal_amount_6_2 CHECK (amount > 0))",
        amount,
        quote
      )
    ).toThrow("not a constraint VibORM wrote");
    for (const tail of ["bad", "0_0"]) {
      const malformed = `CREATE TABLE records (amount INTEGER CONSTRAINT viborm_decimal_amount_${tail} CHECK (1))`;
      expect(() =>
        readSqliteDecimalConstraint(malformed, amount, quote)
      ).toThrow("not a constraint VibORM wrote");
      expect(
        sqliteColumnDefinitionCarriesDecimalDescriptor(malformed, "amount")
      ).toBe(false);
    }
  } finally {
    db.close();
  }
});

test("decimal copy SQL rescales exact coefficients without rounding or reordering", () => {
  const cases: {
    from: DecimalDescriptor | undefined;
    to: DecimalDescriptor;
    kind: DecimalStorageKind;
    input: bigint | number | string | null;
    expected: number | string | null;
  }[] = [
    {
      from: undefined,
      to: { precision: 6, scale: 0 },
      kind: "scalar",
      input: 7n,
      expected: 7,
    },
    {
      from: undefined,
      to: { precision: 6, scale: 2 },
      kind: "scalar",
      input: 7n,
      expected: 700,
    },
    {
      from: { precision: 4, scale: 1 },
      to: { precision: 6, scale: 1 },
      kind: "scalar",
      input: 123n,
      expected: 123,
    },
    {
      from: { precision: 6, scale: 2 },
      to: { precision: 4, scale: 1 },
      kind: "scalar",
      input: 1230n,
      expected: 123,
    },
    {
      from: { precision: 6, scale: 2 },
      to: { precision: 4, scale: 1 },
      kind: "scalar",
      input: 1234n,
      expected: "viborm:decimal-out-of-domain",
    },
    {
      from: { precision: 4, scale: 2 },
      to: { precision: 6, scale: 1 },
      kind: "list",
      input: '["1230","-4560","1230"]',
      expected: '["123","-456","123"]',
    },
    {
      from: { precision: 4, scale: 2 },
      to: { precision: 6, scale: 1 },
      kind: "list",
      input: '["1234"]',
      expected: "viborm:decimal-list-out-of-domain",
    },
    {
      from: { precision: 4, scale: 1 },
      to: { precision: 4, scale: 1 },
      kind: "list",
      input: '["1","1","-2"]',
      expected: '["1","1","-2"]',
    },
  ];
  const db = new Database(":memory:");
  try {
    for (const row of cases) {
      const expression = sqliteDecimalCopyExpression(
        "amount",
        row.from,
        row.to,
        row.kind
      );
      expect(
        db
          .prepare(`SELECT ${expression} AS value FROM (SELECT ? AS amount)`)
          .get(row.input)
      ).toEqual({ value: row.expected });
    }
  } finally {
    db.close();
  }
});
