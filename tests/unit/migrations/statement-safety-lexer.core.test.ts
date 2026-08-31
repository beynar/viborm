/**
 * Lexical edges of the ONE migration-artifact execution classifier.
 *
 * Every case here is a run the scanner has to finish reading correctly or it
 * either hides a boundary statement (an escape) or refuses valid author SQL (a
 * regression). Unterminated runs are included deliberately: a server rejects
 * them as syntax errors, and the classifier must reach that verdict without
 * mis-reading the tail as executable SQL.
 */

import { VibORMErrorCode } from "@src/errors";
import {
  assertArtifactExecutionSafe,
  type ClassifiedDialect,
  readExecutableStatements,
} from "@src/migrations/statement-safety";
import { describe, expect, test } from "vitest";

interface ScanCase {
  readonly name: string;
  readonly dialect: ClassifiedDialect;
  readonly sql: string;
  readonly words: string[][];
}

const scans: readonly ScanCase[] = [
  {
    name: "a PostgreSQL line comment always opens on the second dash",
    dialect: "postgresql",
    sql: "-- COMMIT\nSELECT 1",
    words: [["SELECT"]],
  },
  {
    name: "a SQLite line comment always opens on the second dash",
    dialect: "sqlite",
    sql: "SELECT 1; -- ROLLBACK",
    words: [["SELECT"]],
  },
  {
    name: "a MySQL line comment opens when the dashes end the input",
    dialect: "mysql",
    sql: "SELECT 1--",
    words: [["SELECT"]],
  },
  {
    name: "an unterminated SQLite bracket identifier runs to the end",
    dialect: "sqlite",
    sql: "CREATE TABLE [commit",
    words: [["CREATE", "TABLE"]],
  },
  {
    name: "an unterminated block comment consumes the rest of the chunk",
    dialect: "postgresql",
    sql: "SELECT 1; /* COMMIT; DROP TABLE account",
    words: [["SELECT"]],
  },
  {
    name: "a doubled quote inside a literal keeps it one literal",
    dialect: "postgresql",
    sql: "SELECT 'it''s not a COMMIT'",
    words: [["SELECT"]],
  },
  {
    name: "an unterminated literal runs to the end",
    dialect: "postgresql",
    sql: "SELECT 'COMMIT",
    words: [["SELECT"]],
  },
  {
    name: "an unterminated dollar-quoted body runs to the end",
    dialect: "postgresql",
    sql: "DO $$ BEGIN COMMIT;",
    words: [["DO"]],
  },
  {
    name: "an unterminated quoted identifier names nothing",
    dialect: "postgresql",
    sql: 'SELECT "pg_advisory_unlock_all',
    words: [["SELECT"]],
  },
  {
    name: "an empty quoted run at the end of the input names nothing",
    dialect: "postgresql",
    sql: 'SELECT "',
    words: [["SELECT"]],
  },
];

describe("migration artifact lexical edges", () => {
  test.each(scans)("$name", ({ dialect, sql, words }) => {
    expect(readExecutableStatements(sql, dialect)).toEqual(words);
  });

  test.each(scans)("$name is not a boundary statement", ({ dialect, sql }) => {
    expect(() =>
      assertArtifactExecutionSafe([sql], dialect, "history")
    ).not.toThrow();
  });
});

describe("call position across a comment", () => {
  test("a PostgreSQL line comment between a name and its arguments still calls", () => {
    expect(() =>
      assertArtifactExecutionSafe(
        ["SELECT pg_advisory_unlock_all--wait\n()"],
        "postgresql",
        "history"
      )
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining("pg_advisory_unlock_all"),
      })
    );
  });

  test("a MySQL hash comment between a name and its arguments still calls", () => {
    expect(() =>
      assertArtifactExecutionSafe(
        ["SELECT release_lock#wait\n('migration')"],
        "mysql",
        "history"
      )
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining("release_lock"),
      })
    );
  });
});
