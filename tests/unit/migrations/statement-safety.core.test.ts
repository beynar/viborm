import { VibORMErrorCode } from "@src/errors";
import {
  assertArtifactExecutionSafe,
  needsEnumAdditionCommitBoundary,
  readExecutableStatements,
} from "@src/migrations/statement-safety";
import { describe, expect, test } from "vitest";

describe("migration artifact statement safety", () => {
  test("reads PostgreSQL executable words without treating data as commands", () => {
    const statements = readExecutableStatements(
      [
        "SELECT 'COMMIT', E'ROLLBACK\\'still data'",
        "SELECT $$BEGIN; SELECT pg_advisory_unlock(1)$$",
        '/* outer /* COMMIT */ still data */ SELECT "savepoint"',
      ].join("; "),
      "postgresql"
    );

    expect(statements).toEqual([["SELECT"], ["SELECT"], ["SELECT"]]);
  });

  test("uses MySQL comment and string rules", () => {
    expect(
      readExecutableStatements(
        [
          "SELECT 'RELEASE_LOCK(\\'migration\\')'",
          "# COMMIT\nSELECT 1",
          "-- COMMIT\nSELECT 2",
          "/*!50000 SET AUTOCOMMIT=0 */",
        ].join("; "),
        "mysql"
      )
    ).toEqual([["SELECT"], ["SELECT"], ["SELECT"], ["SET", "AUTOCOMMIT"]]);

    expect(
      readExecutableStatements("SELECT 1--RELEASE_LOCK('migration')", "mysql")
    ).toEqual([["SELECT", "RELEASE_LOCK"]]);
  });

  test("uses SQLite bracket identifiers as names", () => {
    expect(
      readExecutableStatements(
        "CREATE TABLE [begin] ([commit] TEXT DEFAULT 'ROLLBACK')",
        "sqlite"
      )
    ).toEqual([["CREATE", "TABLE", "TEXT", "DEFAULT"]]);
  });

  test.each([
    "ABORT",
    "BEGIN",
    "COMMIT",
    "END",
    "PREPARE /* split */ TRANSACTION 'migration'",
    "RELEASE SAVEPOINT migration",
    "ROLLBACK",
    "SAVEPOINT migration",
    "START TRANSACTION",
  ])("refuses PostgreSQL transaction control: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "history")
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        message: expect.stringContaining("history"),
      })
    );
  });

  test.each([
    "SELECT pg_advisory_unlock(1)",
    "SELECT pg_try_advisory_xact_lock(1)",
    'SELECT pg_catalog."pg_advisory_unlock_all"/**/()',
  ])("refuses a PostgreSQL advisory-lock call: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "history")
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });

  test.each([
    "PREPARE query AS SELECT 1",
    "CREATE TABLE pg_advisory_notes (id INT)",
    'CREATE FUNCTION "pg_advisory_unlock_all"() RETURNS int LANGUAGE SQL AS $$ SELECT 1 $$',
    "SELECT pg_advisory_note FROM audit",
    "SELECT 'COMMIT; pg_advisory_unlock(1)'",
    "DO $$ BEGIN PERFORM pg_advisory_unlock_all(); END $$",
    'SELECT "PG_ADVISORY_UNLOCK_ALL"()',
  ])("accepts PostgreSQL data and non-built-in names: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "postgresql", "history")
    ).not.toThrow();
  });

  test.each([
    "BEGIN",
    "COMMIT",
    "LOCK TABLE account WRITE",
    "RELEASE SAVEPOINT migration",
    "ROLLBACK",
    "SAVEPOINT migration",
    "START TRANSACTION",
    "UNLOCK TABLES",
    "XA START 'migration'",
    "SET AUTOCOMMIT = 0",
    "SET @@autocommit = 1",
    "SELECT GET_LOCK('migration', 30)",
    "SELECT IS_FREE_LOCK('migration')",
    "SELECT IS_USED_LOCK('migration')",
    "SELECT RELEASE_ALL_LOCKS()",
    "SELECT RELEASE_LOCK('migration')",
    "/*!40101 SET AUTOCOMMIT=0 */",
    "SELECT 1--RELEASE_LOCK('migration')",
  ])("refuses MySQL boundary control: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "mysql", "history")
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });

  test.each([
    "SET @autocommit = 0",
    "CREATE TABLE get_lock (id INT)",
    "CREATE TABLE audit (release_lock INT)",
    "SELECT `release_lock`('migration')",
    "SELECT \"RELEASE_LOCK(\\'migration\\')\"",
    "SELECT 1 -- RELEASE_LOCK('migration')",
    "SELECT 1 # RELEASE_LOCK('migration')",
    "/* SET AUTOCOMMIT = 0 */ SELECT 1",
  ])("accepts MySQL data and non-built-in names: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "mysql", "history")
    ).not.toThrow();
  });

  test.each([
    "BEGIN",
    "COMMIT",
    "END",
    "RELEASE migration",
    "ROLLBACK",
    "SAVEPOINT migration",
  ])("refuses SQLite transaction control: %s", (statement) => {
    expect(() =>
      assertArtifactExecutionSafe([statement], "sqlite", "history")
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      })
    );
  });

  test.each([
    "TRIGGER",
    "TEMP TRIGGER",
    "TEMPORARY TRIGGER",
  ])("accepts SQLite %s body controls as trigger grammar", (kind) => {
    const statement = `CREATE ${kind} audit AFTER INSERT ON account BEGIN INSERT INTO log VALUES ('BEGIN'); END`;
    expect(() =>
      assertArtifactExecutionSafe([statement], "sqlite", "history")
    ).not.toThrow();
  });

  test("classifies every statement in an artifact chunk", () => {
    expect(() =>
      assertArtifactExecutionSafe(
        ["CREATE TABLE account(id int); COMMIT; SELECT 1"],
        "postgresql",
        "multi-statement"
      )
    ).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("COMMIT"),
      })
    );
  });

  test("detects only executable PostgreSQL enum additions", () => {
    expect(
      needsEnumAdditionCommitBoundary([
        "SELECT 'ALTER TYPE status ADD VALUE pending'",
        "/* ALTER TYPE status ADD VALUE 'pending' */ SELECT 1",
      ])
    ).toBe(false);
    expect(
      needsEnumAdditionCommitBoundary([
        "CREATE TABLE account(id int); ALTER TYPE status ADD VALUE 'pending'",
      ])
    ).toBe(true);
  });
});
