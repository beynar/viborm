import { VibORMErrorCode } from "@src/errors";
import { canonicalizeIndexPredicates } from "@src/migrations/drivers/postgres/canonicalize-index-predicate";
import { describe, expect, test } from "vitest";
import { pgEstateDriver } from "./_estate";

describe("PostgreSQL partial-index predicate canonicalization", () => {
  test("does no session work when there is no predicate", async () => {
    const driver = pgEstateDriver("tenant");

    await expect(
      canonicalizeIndexPredicates('"tenant"."account"', [], (sql, parameters) =>
        driver._executeRaw(sql, parameters)
      )
    ).resolves.toEqual([]);
    expect(driver.statements).toEqual([]);
  });

  test("deparses predicates positionally through temporary views", async () => {
    const driver = pgEstateDriver("tenant");
    driver.respond = (sql) =>
      sql.startsWith("SELECT pg_catalog.pg_get_viewdef")
        ? [{ d0: "(active = true)", d1: null }]
        : [];

    const result = await canonicalizeIndexPredicates(
      '"tenant"."account"',
      ["active = true", "deleted_at IS NULL"],
      (sql, parameters) => driver._executeRaw(sql, parameters)
    );

    expect(result).toEqual(["(active = true)", undefined]);
    expect(driver.statements.slice(1)).toEqual([
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_0" AS SELECT 1 AS c FROM "tenant"."account" WHERE active = true',
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_1" AS SELECT 1 AS c FROM "tenant"."account" WHERE deleted_at IS NULL',
      'SELECT pg_catalog.pg_get_viewdef(\'pg_temp."viborm_index_predicate_0"\'::regclass) AS "d0", pg_catalog.pg_get_viewdef(\'pg_temp."viborm_index_predicate_1"\'::regclass) AS "d1"',
      'DROP VIEW pg_temp."viborm_index_predicate_0", pg_temp."viborm_index_predicate_1"',
    ]);
    expect(driver.parameters).toEqual([[], [], [], [], []]);
  });

  test("leaves cleanup to the caller transaction after a failed deparse", async () => {
    const driver = pgEstateDriver("tenant");
    const failure = new Error("predicate rejected");
    driver.respond = (sql) =>
      sql.includes("WHERE invalid predicate") ? failure : [];

    await expect(
      canonicalizeIndexPredicates(
        '"tenant"."account"',
        ["active = true", "invalid predicate"],
        (sql, parameters) => driver._executeRaw(sql, parameters)
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.QUERY_FAILED,
      meta: { driver: "pg", operation: "executeRaw" },
    });
    expect(driver.statements.some((sql) => sql.startsWith("DROP VIEW"))).toBe(
      false
    );
  });
});
