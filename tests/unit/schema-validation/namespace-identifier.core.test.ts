/**
 * The namespace grammar, at its one owner.
 *
 * `src/schema/identifier.ts` answers "is this a legal SQL qualification name"
 * for every entry into the feature: the seven driver option types, the two
 * public adapter constructors, and MySQL2's derived targets. The admission and
 * refusal matrices live here, at the boundary that decides them; the driver and
 * adapter suites prove that each public surface reaches this owner rather than
 * restating the matrix.
 */

import { ClientInitializationError } from "@errors";
import {
  isValidSchemaIdentifier,
  MAX_SCHEMA_IDENTIFIER_BYTES,
  normalizeNamespace,
} from "@schema/identifier";
import { describe, expect, test } from "vitest";

const repeat = (length: number): string => "a".repeat(length);

const NOT_A_STRING = /must be a string/;
const PROTOTYPE_NAME = /Object\.prototype/;
const POSTGRES_LIMIT = /at most 63 characters/;
const MYSQL_LIMIT = /at most 64 characters/;
const SYSTEM_SCHEMA = /system schema/;
const SYSTEM_DATABASE = /system database/;
const POSTGRES_DIALECT = /PostgreSQL/;
const MYSQL_DIALECT = /MySQL/;

describe("namespace normalization", () => {
  describe("shared grammar", () => {
    test.each([
      ["ordinary lowercase", "billing"],
      ["preserved uppercase", "Billing"],
      ["fully uppercase", "BILLING"],
      ["leading underscore", "_billing"],
      ["digits after the first character", "billing2"],
      // The renderer quotes every component, so a keyword is an ordinary name.
      ["a reserved keyword", "select"],
      ["another reserved keyword", "table"],
    ])("admits %s for both dialects", (_label, value) => {
      expect(normalizeNamespace(value, "postgresql")).toBe(value);
      expect(normalizeNamespace(value, "mysql")).toBe(value);
    });

    test.each([
      ["an empty string", ""],
      ["a dotted name", "billing.user"],
      ["a leading digit", "1billing"],
      ["a hyphen", "billing-eu"],
      ["a space", "billing eu"],
      ["a double quote", 'bil"ling'],
      ["a backtick", "bil`ling"],
      ["a backslash", "bil\\ling"],
      ["a NUL byte", "billing\u0000name"],
      ["a semicolon", "billing; DROP SCHEMA public"],
      ["a PlanetScale primary selector", "@primary"],
      ["a PlanetScale replica selector", "@replica"],
      ["a non-ASCII letter", "facturación"],
    ])("refuses %s for both dialects", (_label, value) => {
      expect(() => normalizeNamespace(value, "postgresql")).toThrow(
        ClientInitializationError
      );
      expect(() => normalizeNamespace(value, "mysql")).toThrow(
        ClientInitializationError
      );
    });

    test.each([
      ["undefined", undefined],
      ["null", null],
      ["a number", 3],
      ["a boolean", true],
      ["a bigint", 1n],
      ["a symbol", Symbol("billing")],
      ["an object", { toString: () => "billing" }],
      ["an array", ["billing"]],
      ["a function", () => "billing"],
    ])("refuses %s without rendering it", (_label, value) => {
      expect(() => normalizeNamespace(value, "postgresql")).toThrow(
        NOT_A_STRING
      );
      expect(() => normalizeNamespace(value, "mysql")).toThrow(NOT_A_STRING);
    });

    test.each([
      "constructor",
      "toString",
      "__proto__",
      "valueOf",
    ])("refuses the Object.prototype name %s", (value) => {
      expect(() => normalizeNamespace(value, "postgresql")).toThrow(
        PROTOTYPE_NAME
      );
      expect(() => normalizeNamespace(value, "mysql")).toThrow(PROTOTYPE_NAME);
    });
  });

  describe("dialect length limits", () => {
    test("PostgreSQL admits 63 characters and refuses 64", () => {
      expect(normalizeNamespace(repeat(63), "postgresql")).toBe(repeat(63));
      expect(() => normalizeNamespace(repeat(64), "postgresql")).toThrow(
        POSTGRES_LIMIT
      );
    });

    test("MySQL admits 64 characters and refuses 65", () => {
      expect(normalizeNamespace(repeat(64), "mysql")).toBe(repeat(64));
      expect(() => normalizeNamespace(repeat(65), "mysql")).toThrow(
        MYSQL_LIMIT
      );
    });

    test("the PostgreSQL limit is the schema-identifier limit", () => {
      expect(MAX_SCHEMA_IDENTIFIER_BYTES).toBe(63);
    });
  });

  describe("PostgreSQL system schemas", () => {
    test.each([
      "information_schema",
      "pg_catalog",
      "pg_toast",
      "pg_temp_1",
      "pg_anything_at_all",
      "pg_",
    ])("refuses %s", (value) => {
      expect(() => normalizeNamespace(value, "postgresql")).toThrow(
        SYSTEM_SCHEMA
      );
    });

    test.each([
      "INFORMATION_SCHEMA",
      "PG_CATALOG",
      "Pg_catalog",
    ])("admits the case-different %s, because quoted names are case-sensitive", (value) => {
      expect(normalizeNamespace(value, "postgresql")).toBe(value);
    });

    test("admits public and ordinary schemas", () => {
      expect(normalizeNamespace("public", "postgresql")).toBe("public");
      expect(normalizeNamespace("pgbouncer", "postgresql")).toBe("pgbouncer");
    });
  });

  describe("MySQL system databases", () => {
    test.each([
      "information_schema",
      "INFORMATION_SCHEMA",
      "mysql",
      "MySQL",
      "performance_schema",
      "Performance_Schema",
      "sys",
      "SYS",
      "ndbinfo",
      "NdbInfo",
    ])("refuses %s case-insensitively", (value) => {
      expect(() => normalizeNamespace(value, "mysql")).toThrow(SYSTEM_DATABASE);
    });

    test("admits ordinary mixed case", () => {
      expect(normalizeNamespace("AppProd", "mysql")).toBe("AppProd");
      expect(normalizeNamespace("mysql_reports", "mysql")).toBe(
        "mysql_reports"
      );
    });

    test("does not apply the PostgreSQL system rule", () => {
      expect(normalizeNamespace("pg_catalog", "mysql")).toBe("pg_catalog");
    });
  });

  test("names the dialect it refused for", () => {
    expect(() => normalizeNamespace("pg_catalog", "postgresql")).toThrow(
      POSTGRES_DIALECT
    );
    expect(() => normalizeNamespace("sys", "mysql")).toThrow(MYSQL_DIALECT);
  });

  test("an ordinary refusal fabricates no cause", () => {
    let refusal: unknown;
    try {
      normalizeNamespace("billing.user", "postgresql");
    } catch (thrown) {
      refusal = thrown;
    }
    expect(refusal).toBeInstanceOf(ClientInitializationError);
    expect(
      refusal instanceof ClientInitializationError
        ? refusal.originalCause
        : refusal
    ).toBeUndefined();
  });
});

describe("isValidSchemaIdentifier", () => {
  test("accepts an ordinary identifier", () => {
    expect(isValidSchemaIdentifier("user_id")).toBe(true);
  });

  test.each([
    ["a non-string", 7],
    ["an over-long name", repeat(64)],
    ["a name outside the grammar", "user-id"],
    ["an Object.prototype name", "constructor"],
  ])("refuses %s", (_label, value) => {
    expect(isValidSchemaIdentifier(value)).toBe(false);
  });
});
