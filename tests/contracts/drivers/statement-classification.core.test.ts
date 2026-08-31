import { parseMySQLUrl } from "@drivers/shared/mysql-utils";
import { getTopLevelStatementTokens } from "@drivers/shared/sql-statement-tokens";
import {
  classifySQLiteStatementResult,
  isSQLiteInsertStatement,
} from "@drivers/shared/sqlite-statement-classifier";
import { describe, expect, test } from "vitest";

describe("driver SQL statement classification", () => {
  test("tokenizes one statement without interpreting literals, comments, or parameters", () => {
    const tokens = getTopLevelStatementTokens(`
      -- leading comment
      WITH "selected" AS (
        SELECT ':ignored', $named, @other, :third FROM [event]]archive]
      )
      SELECT \`value\` FROM "selected" /* trailing comment */;
    `);

    expect(tokens).toEqual([
      { depth: 0, kind: "word", value: "WITH" },
      { depth: 0, kind: "identifier", value: "SELECTED" },
      { depth: 0, kind: "word", value: "AS" },
      { depth: 0, kind: "symbol", value: "(" },
      { depth: 0, kind: "symbol", value: ")" },
      { depth: 0, kind: "word", value: "SELECT" },
      { depth: 0, kind: "identifier", value: "VALUE" },
      { depth: 0, kind: "word", value: "FROM" },
      { depth: 0, kind: "identifier", value: "SELECTED" },
    ]);
  });

  test("honors MySQL backslash escapes without changing the default grammar", () => {
    const statement = "SELECT 'can" + "\\" + "'t' AS value";

    expect(getTopLevelStatementTokens(statement)).toBeUndefined();
    expect(
      getTopLevelStatementTokens(statement, { backslashEscapes: true })
    ).toEqual([
      { depth: 0, kind: "word", value: "SELECT" },
      { depth: 0, kind: "word", value: "AS" },
      { depth: 0, kind: "word", value: "VALUE" },
    ]);
  });

  test.each([
    "SELECT 1 /* unterminated",
    "SELECT 'unterminated",
    'SELECT "unterminated',
    "SELECT (1",
    "SELECT 1)",
    "SELECT 1; SELECT 2",
    "SELECT 1; 'trailing literal'",
    'SELECT 1; "trailing identifier"',
  ])("refuses an ambiguous or multi-statement input: %s", (statement) => {
    expect(getTopLevelStatementTokens(statement)).toBeUndefined();
  });

  test.each([
    ["SELECT value FROM event", "rows"],
    ["VALUES (1)", "rows"],
    ["EXPLAIN SELECT 1", "rows"],
    ["WITH selected AS (SELECT 1) SELECT * FROM selected", "rows"],
    ["INSERT INTO event VALUES (1) RETURNING id", "rows"],
    ["WITH changed AS (SELECT 1) UPDATE event SET value = 2 RETURNING id", "rows"],
    ["INSERT INTO event VALUES (1)", "no-rows"],
    ["REPLACE INTO event VALUES (1)", "no-rows"],
    ["DELETE FROM event", "no-rows"],
    ["CREATE TABLE event (id integer)", "no-rows"],
    ["SAVEPOINT nested", "no-rows"],
    ["PRAGMA foreign_keys", "rows"],
    ["PRAGMA optimize", "no-rows"],
    ["PRAGMA foreign_keys = ON", "no-rows"],
    ['PRAGMA main."foreign_keys"(ON)', "no-rows"],
    ["PRAGMA application_id = 1", "rows"],
    ["BROKEN STATEMENT", "unknown"],
    ['"SELECT" value', "unknown"],
    ["WITH selected AS (SELECT 1)", "unknown"],
    ["SELECT (1", "unknown"],
  ] as const)("classifies %s as %s", (statement, expected) => {
    expect(classifySQLiteStatementResult(statement)).toBe(expected);
  });

  test.each([
    ["INSERT INTO event VALUES (1)", true],
    ["REPLACE INTO event VALUES (1)", true],
    ["WITH value AS (SELECT 1) INSERT INTO event SELECT * FROM value", true],
    ["UPDATE event SET value = 1", false],
    ["WITH value AS (SELECT 1)", false],
    ["SELECT (1", false],
  ] as const)("detects insert metadata ownership for %s", (statement, expected) => {
    expect(isSQLiteInsertStatement(statement)).toBe(expected);
  });
});

describe("shared MySQL URL parsing", () => {
  test("preserves an explicit connection target", () => {
    expect(
      parseMySQLUrl("mysql://user:password@db.test:3307/application")
    ).toEqual({
      host: "db.test",
      port: 3307,
      database: "application",
      user: "user",
      password: "password",
    });
  });

  test("does not erase separately configured credentials or database with empty URL members", () => {
    expect(parseMySQLUrl("mysql://db.test")).toEqual({
      host: "db.test",
      port: 3306,
      user: undefined,
      password: undefined,
    });
  });
});
