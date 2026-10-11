/**
 * T5a at the layer the migration coverage gate measures: the PostgreSQL
 * preflight that refuses a rewrite or scan of a table the planner estimates
 * above `limits.largeTableRows`, before any effect.
 *
 * `large-table-refusal.test.ts` proves it on a seeded PGlite table; here the
 * two catalog answers it decides on (`to_regclass` and the `EXPLAIN` estimate)
 * are given directly, so each arm of the decision is pinned by what was asked
 * and what was refused.
 */

import { readArrayLiteralText } from "@adapters/databases/postgres/array-literal";
import { VibORMErrorCode } from "@errors";
import type { ResolvedMigrationLimits } from "@src/drivers/shared/pinned-session";
import { DEFAULT_MIGRATION_LIMITS } from "@src/drivers/shared/pinned-session";
import { getMigrationDriver } from "@src/migrations/drivers";
import { describe, expect, it } from "vitest";
import { pgEstateDriver } from "./_estate";

const ACCOUNTS = '"public"."accounts"';
const TEAMS = '"public"."teams"';
const TYPE_CHANGE = `ALTER TABLE ${ACCOUNTS} ALTER COLUMN "age" TYPE bigint USING "age"::bigint`;
const FOREIGN_KEY = `ALTER TABLE ${ACCOUNTS} ADD CONSTRAINT "accounts_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES ${TEAMS} ("id")`;
const CHECK = `ALTER TABLE ${ACCOUNTS} ADD CONSTRAINT "viborm_decimal" CHECK ("price" = "price"::numeric(12,4))`;
const NOT_NULL = `ALTER TABLE ${TEAMS} ALTER COLUMN "name" SET NOT NULL`;
const STEP_FORM = "Or add the constraint NOT VALID";

/**
 * One catalog: the relations that exist and the planner's row estimate for
 * each (`null`: a plan line without one).
 */
function catalog(estimates: Readonly<Record<string, number | null>>) {
  const asked: string[] = [];
  const executeRaw = <T>(sql: string, params?: unknown[]) => {
    asked.push(sql);
    if (sql.includes("pg_catalog.to_regclass")) {
      const names = readArrayLiteralText(String(params?.[0])) ?? [];
      return Promise.resolve({
        rows: names.map((name) => ({
          relation: name !== null && name in estimates ? name : null,
        })) as T[],
        rowCount: names.length,
      });
    }
    const explained = sql.startsWith("EXPLAIN SELECT 1 FROM ")
      ? sql.slice("EXPLAIN SELECT 1 FROM ".length)
      : undefined;
    if (explained !== undefined) {
      const rows = estimates[explained];
      const size = rows === null ? "" : ` rows=${rows}`;
      return Promise.resolve({
        rows: [
          {
            "QUERY PLAN": `Seq Scan on accounts  (cost=0.00..1.00${size} width=0)`,
          },
        ] as T[],
        rowCount: 1,
      });
    }
    return Promise.resolve({ rows: [] as T[], rowCount: 0 });
  };
  return { asked, executeRaw };
}

function preflight(
  program: readonly string[],
  estimates: Readonly<Record<string, number | null>>,
  limits: Partial<ResolvedMigrationLimits> = {}
) {
  const driver = getMigrationDriver(pgEstateDriver("public"), undefined, {
    ...DEFAULT_MIGRATION_LIMITS,
    ...limits,
  });
  const live = catalog(estimates);
  return {
    asked: live.asked,
    run: driver.preflightSchemaRequirements([], live.executeRaw, program),
  };
}

describe("a rewrite or scan above limits.largeTableRows", () => {
  it("is refused naming the operation, the table and the estimate", async () => {
    const { run, asked } = preflight([TYPE_CHANGE], { [ACCOUNTS]: 2_000_000 });

    await expect(run).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        `runs a column type change of "age" on ${ACCOUNTS}, which the planner estimates at 2000000 rows, above limits.largeTableRows (1000000)`
      ),
      meta: {
        table: ACCOUNTS,
        operation: 'column type change of "age"',
        feature: "large table rewrite",
      },
    });
    await expect(run).rejects.not.toThrow(STEP_FORM);
    // One relation lookup and one estimate: the refusal reads nothing else.
    expect(asked).toEqual([
      expect.stringContaining("pg_catalog.to_regclass"),
      `EXPLAIN SELECT 1 FROM ${ACCOUNTS}`,
    ]);
  });

  it("joins every operation on that table, and offers the step form only for validations", async () => {
    const validations = preflight(
      [FOREIGN_KEY, CHECK],
      {
        [ACCOUNTS]: 5000,
      },
      { largeTableRows: 4999 }
    );
    await expect(validations.run).rejects.toMatchObject({
      meta: { operation: "FOREIGN KEY validation and CHECK validation" },
      message: expect.stringContaining(STEP_FORM),
    });

    const mixed = preflight(
      [FOREIGN_KEY, TYPE_CHANGE],
      { [ACCOUNTS]: 5000 },
      {
        largeTableRows: 4999,
      }
    );
    await expect(mixed.run).rejects.toMatchObject({
      meta: {
        operation: 'FOREIGN KEY validation and column type change of "age"',
      },
    });
    await expect(mixed.run).rejects.not.toThrow(STEP_FORM);
  });

  it("is decided per table, in program order", async () => {
    const { run, asked } = preflight([NOT_NULL, TYPE_CHANGE], {
      [TEAMS]: 10,
      [ACCOUNTS]: 2_000_000,
    });

    await expect(run).rejects.toMatchObject({ meta: { table: ACCOUNTS } });
    expect(asked).toEqual([
      expect.stringContaining("pg_catalog.to_regclass"),
      `EXPLAIN SELECT 1 FROM ${TEAMS}`,
      `EXPLAIN SELECT 1 FROM ${ACCOUNTS}`,
    ]);
  });

  it("is refused when the plan reports no row estimate: what is not measured is not admitted", async () => {
    const { run } = preflight([TYPE_CHANGE], { [ACCOUNTS]: null });

    await expect(run).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining(
        `runs a column type change of "age" on ${ACCOUNTS}, whose row estimate EXPLAIN SELECT 1 FROM ${ACCOUNTS} did not report ("Seq Scan on accounts  (cost=0.00..1.00 width=0)"), so limits.largeTableRows (1000000) cannot admit it`
      ),
      meta: { table: ACCOUNTS, feature: "large table rewrite" },
    });
  });
});

describe("what the preflight admits", () => {
  it("admits a rewrite at or below the limit", async () => {
    const { run, asked } = preflight([TYPE_CHANGE], { [ACCOUNTS]: 1_000_000 });

    await expect(run).resolves.toBeUndefined();
    expect(asked).toContain(`EXPLAIN SELECT 1 FROM ${ACCOUNTS}`);
  });

  it("admits a table that does not exist yet without estimating it", async () => {
    const { run, asked } = preflight([TYPE_CHANGE], {});

    await expect(run).resolves.toBeUndefined();
    expect(asked.some((sql) => sql.startsWith("EXPLAIN"))).toBe(false);
  });

  it("reads no catalog for a program with no rewrite", async () => {
    const { run, asked } = preflight(
      [`ALTER TABLE ${ACCOUNTS} ADD COLUMN "nickname" text`],
      { [ACCOUNTS]: 2_000_000 }
    );

    await expect(run).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("largeTableRows: 0 is no limit: nothing is classified or read", async () => {
    const { run, asked } = preflight(
      [TYPE_CHANGE],
      { [ACCOUNTS]: 2_000_000 },
      { largeTableRows: 0 }
    );

    await expect(run).resolves.toBeUndefined();
    expect(asked).toEqual([]);
  });
});
