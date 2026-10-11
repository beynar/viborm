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

  test("deparses predicates positionally through temporary views, then deparses each answer once more", async () => {
    const driver = pgEstateDriver("tenant");
    const answers = [
      {
        d0: " SELECT 1 AS c\n   FROM account\n  WHERE (((age >= 18) AND (age <= 65)) AND active);",
        d1: null,
      },
      {
        d0: " SELECT 1 AS c\n   FROM account\n  WHERE ((age >= 18) AND (age <= 65) AND active);",
      },
    ];
    driver.respond = (sql) =>
      sql.startsWith("SELECT pg_catalog.pg_get_viewdef")
        ? [answers.shift()]
        : [];

    const result = await canonicalizeIndexPredicates(
      '"tenant"."account"',
      ['"age" BETWEEN 18 AND 65 AND active', "deleted_at IS NULL"],
      (sql, parameters) => driver._executeRaw(sql, parameters)
    );

    expect(result).toEqual([
      " SELECT 1 AS c\n   FROM account\n  WHERE ((age >= 18) AND (age <= 65) AND active);",
      undefined,
    ]);
    expect(driver.statements.slice(1)).toEqual([
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_0" AS SELECT 1 AS c FROM "tenant"."account" WHERE "age" BETWEEN 18 AND 65 AND active',
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_1" AS SELECT 1 AS c FROM "tenant"."account" WHERE deleted_at IS NULL',
      'SELECT pg_catalog.pg_get_viewdef(\'pg_temp."viborm_index_predicate_0"\'::regclass) AS "d0", pg_catalog.pg_get_viewdef(\'pg_temp."viborm_index_predicate_1"\'::regclass) AS "d1"',
      'DROP VIEW pg_temp."viborm_index_predicate_0", pg_temp."viborm_index_predicate_1"',
      // The first answer reparsed, without its terminator; a position with
      // no answer is not reparsed, and has no view in this pass.
      'CREATE OR REPLACE TEMP VIEW "viborm_index_predicate_0" AS  SELECT 1 AS c\n   FROM account\n  WHERE (((age >= 18) AND (age <= 65)) AND active)',
      'SELECT pg_catalog.pg_get_viewdef(\'pg_temp."viborm_index_predicate_0"\'::regclass) AS "d0"',
      'DROP VIEW pg_temp."viborm_index_predicate_0"',
    ]);
    expect(driver.parameters).toEqual([[], [], [], [], [], [], [], []]);
  });

  test("sends each pass as one request where no session can be pinned", async () => {
    const requests: (readonly string[])[] = [];
    const result = await canonicalizeIndexPredicates(
      '"tenant"."account"',
      ["deleted_at IS NULL"],
      () => Promise.reject(new Error("no statement may go out alone")),
      <T>(statements: readonly string[]) => {
        requests.push(statements);
        // A stub of the generic executor: its one read answers this row.
        const read = {
          d0: " SELECT 1 AS c\n   FROM account\n  WHERE (deleted_at IS NULL);",
        } as T;
        return Promise.resolve(
          statements.map((sql) => ({
            rows: sql.startsWith("SELECT") ? [read] : [],
          }))
        );
      }
    );

    expect(result).toEqual([
      " SELECT 1 AS c\n   FROM account\n  WHERE (deleted_at IS NULL);",
    ]);
    expect(requests.map((statements) => statements.length)).toEqual([3, 3]);
    for (const [create, , drop] of requests) {
      expect(create?.startsWith("CREATE OR REPLACE TEMP VIEW")).toBe(true);
      expect(drop?.startsWith("DROP VIEW")).toBe(true);
    }
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
