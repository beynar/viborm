import { VibORMErrorCode } from "@src/errors";
import { canonicalizeIndexPredicates } from "@src/migrations/drivers/postgres/canonicalize-index-predicate";
import { describe, expect, test } from "vitest";
import { pgEstateDriver } from "./_estate";

const RANDOM = /viborm_index_predicate_[0-9a-f]{32}_/g;
const VIEW_NAMES = /'(viborm_index_predicate_[0-9a-f]{32}_\d+)'/g;

/** The statements with each scratch view's random part spelled `<r>`. */
const normalized = (statements: readonly string[]) =>
  statements.map((sql) => sql.replace(RANDOM, "viborm_index_predicate_<r>_"));

/** The pg_class read's answer: each named view's deparse, by its position. */
function viewDefinitions(sql: string, definitions: readonly (string | null)[]) {
  return [...sql.matchAll(VIEW_NAMES)].map(([, name], index) => ({
    name,
    definition: definitions[index],
  }));
}

describe("PostgreSQL partial-index predicate canonicalization", () => {
  test("does no session work when there is no predicate", async () => {
    const driver = pgEstateDriver("tenant");

    await expect(
      canonicalizeIndexPredicates(
        "tenant",
        '"tenant"."account"',
        [],
        (sql, parameters) => driver._executeRaw(sql, parameters)
      )
    ).resolves.toEqual([]);
    expect(driver.statements).toEqual([]);
  });

  test("deparses predicates positionally through scratch views of the estate's schema, then deparses each answer once more", async () => {
    const driver = pgEstateDriver("tenant");
    const answers = [
      [
        " SELECT 1 AS c\n   FROM account\n  WHERE (((age >= 18) AND (age <= 65)) AND active);",
        null,
      ],
      [
        " SELECT 1 AS c\n   FROM account\n  WHERE ((age >= 18) AND (age <= 65) AND active);",
      ],
    ];
    driver.respond = (sql) =>
      sql.includes("pg_catalog.pg_get_viewdef")
        ? viewDefinitions(sql, answers.shift() ?? [])
        : [];

    const result = await canonicalizeIndexPredicates(
      "tenant",
      '"tenant"."account"',
      ['"age" BETWEEN 18 AND 65 AND active', "deleted_at IS NULL"],
      (sql, parameters) => driver._executeRaw(sql, parameters)
    );

    expect(result).toEqual([
      " SELECT 1 AS c\n   FROM account\n  WHERE ((age >= 18) AND (age <= 65) AND active);",
      undefined,
    ]);
    const read = (names: string) =>
      `SELECT c.relname AS name, pg_catalog.pg_get_viewdef(c.oid) AS definition FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'tenant' AND c.relname IN (${names})`;
    // No temporary view and no `regclass`: Neki has neither (NK013, and its
    // router does not resolve a relation the transaction created).
    expect(normalized(driver.statements.slice(1))).toEqual([
      'CREATE VIEW "tenant"."viborm_index_predicate_<r>_0" AS SELECT 1 AS c FROM "tenant"."account" WHERE "age" BETWEEN 18 AND 65 AND active',
      'CREATE VIEW "tenant"."viborm_index_predicate_<r>_1" AS SELECT 1 AS c FROM "tenant"."account" WHERE deleted_at IS NULL',
      read("'viborm_index_predicate_<r>_0', 'viborm_index_predicate_<r>_1'"),
      'DROP VIEW "tenant"."viborm_index_predicate_<r>_0", "tenant"."viborm_index_predicate_<r>_1"',
      // The first answer reparsed, without its terminator; a position with
      // no answer is not reparsed, and has no view in this pass.
      'CREATE VIEW "tenant"."viborm_index_predicate_<r>_0" AS  SELECT 1 AS c\n   FROM account\n  WHERE (((age >= 18) AND (age <= 65)) AND active)',
      read("'viborm_index_predicate_<r>_0'"),
      'DROP VIEW "tenant"."viborm_index_predicate_<r>_0"',
    ]);
    expect(driver.parameters).toEqual([[], [], [], [], [], [], [], []]);
    // Each pass names its views apart, so no two sessions wait on one name.
    const [first, , , , second] = driver.statements.slice(1);
    expect(first?.match(RANDOM)).not.toEqual(second?.match(RANDOM));
  });

  test("sends each pass as one request where no session can be pinned", async () => {
    const requests: (readonly string[])[] = [];
    const result = await canonicalizeIndexPredicates(
      "tenant",
      '"tenant"."account"',
      ["deleted_at IS NULL"],
      () => Promise.reject(new Error("no statement may go out alone")),
      <T>(statements: readonly string[]) => {
        requests.push(statements);
        // A stub of the generic executor: its one read answers this row.
        return Promise.resolve(
          statements.map((sql) => ({
            rows: (sql.startsWith("SELECT")
              ? viewDefinitions(sql, [
                  " SELECT 1 AS c\n   FROM account\n  WHERE (deleted_at IS NULL);",
                ])
              : []) as T[],
          }))
        );
      }
    );

    expect(result).toEqual([
      " SELECT 1 AS c\n   FROM account\n  WHERE (deleted_at IS NULL);",
    ]);
    expect(requests.map((statements) => statements.length)).toEqual([3, 3]);
    for (const [create, , drop] of requests) {
      expect(create?.startsWith('CREATE VIEW "tenant".')).toBe(true);
      expect(drop?.startsWith('DROP VIEW "tenant".')).toBe(true);
    }
  });

  test("leaves cleanup to the caller transaction after a failed deparse", async () => {
    const driver = pgEstateDriver("tenant");
    const failure = new Error("predicate rejected");
    driver.respond = (sql) =>
      sql.includes("WHERE invalid predicate") ? failure : [];

    await expect(
      canonicalizeIndexPredicates(
        "tenant",
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
