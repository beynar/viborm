import { MySQL2Driver } from "@drivers/mysql2";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";
import type { OperationStep } from "../../src/query-engine-v2/OperationFragment";
import { planningKey } from "../../src/query-engine-v2/Part";
import { constructRoutedOperation } from "../../src/query-engine-v2/routing";

/** The SQL text of a statement step (guard steps carry no statement). */
function sqlOf(step: OperationStep): string {
  if (!("statement" in step)) throw new Error("expected a statement step");
  return step.statement.strings.join("");
}

/**
 * `updateMany`/`deleteMany` `limit`, pinned STRUCTURALLY — no database.
 *
 * Two facts the behavioral driver suites cannot see, because both are about what
 * is NOT sent:
 *
 *  1. `limit: 0` executes NO statement at all. It is not `LIMIT 0` and not a
 *     `WHERE FALSE`: the operation compiles to the empty plan and answers
 *     `{ count: 0 }` / `[]` from nothing. A regression to "run the write with a
 *     zero cap" would still return the right numbers on every dialect, so only a
 *     plan-shaped assertion can catch it — and on the PK-subquery dialects that
 *     regression would take locks for a write that cannot affect a row.
 *  2. WHICH spelling each dialect gets. MySQL takes the native `UPDATE … LIMIT n`
 *     (the PK subquery would re-read the mutated table and trip ERROR 1093);
 *     PostgreSQL and SQLite take `WHERE pk IN (SELECT pk … LIMIT n)` (neither has
 *     `UPDATE … LIMIT`). Both answers are correct, so a behavioral test passes
 *     either way; this is the tripwire that keeps a dialect from silently
 *     acquiring the other one's form.
 *
 * Planning and compile are pure, so no driver connects here.
 */
const gadget = s
  .model({
    id: s.string().id(),
    code: s.string().unique(),
    name: s.string(),
    qty: s.int().default(0),
  })
  .map("limit_plan_gadgets");

const schema = { gadget };

beforeAll(() => {
  hydrateSchemaNames(schema);
});

type DriverName = "PGlite" | "SQLite3" | "MySQL2";

function engine(driverName: DriverName): QueryEngine {
  const schemas = createSchemaRegistry(schema);
  const driver =
    driverName === "MySQL2"
      ? new MySQL2Driver()
      : driverName === "SQLite3"
        ? new SQLite3Driver()
        : new PGliteDriver();
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

function route(
  driverName: DriverName,
  operation: "updateMany" | "deleteMany",
  args: Record<string, unknown>
) {
  const routed = constructRoutedOperation(
    engine(driverName),
    schema.gadget,
    operation,
    args
  );
  if (!routed) throw new Error(`'${operation}' did not route`);
  return routed;
}

const NATIVE_LIMIT = /LIMIT/;
const PK_SUBQUERY = /IN \(SELECT/;

describe("limit: 0 compiles to no statement at all", () => {
  const drivers: DriverName[] = ["PGlite", "SQLite3", "MySQL2"];

  for (const driverName of drivers) {
    test(`${driverName}: the { count } arm plans and compiles to nothing`, () => {
      for (const operation of ["updateMany", "deleteMany"] as const) {
        const routed = route(driverName, operation, {
          where: { name: "Alpha" },
          ...(operation === "updateMany" ? { data: { qty: 1 } } : {}),
          limit: 0,
        });
        expect(routed.planning().steps).toEqual([]);
        const compiled = routed.compile({});
        expect(compiled.steps).toEqual([]);
        // The answer still exists — it just did not come from a database.
        expect(routed.parse(compiled.outputs)).toEqual({ count: 0 });
      }
    });

    test(`${driverName}: the select arm plans and compiles to nothing`, () => {
      for (const operation of ["updateMany", "deleteMany"] as const) {
        const routed = route(driverName, operation, {
          where: { name: "Alpha" },
          ...(operation === "updateMany" ? { data: { qty: 1 } } : {}),
          limit: 0,
          select: { id: true },
        });
        expect(routed.planning().steps).toEqual([]);
        const compiled = routed.compile({});
        expect(compiled.steps).toEqual([]);
        expect(routed.parse(compiled.outputs)).toEqual([]);
      }
    });
  }

  test("the control: limit 1 does compile a write", () => {
    const routed = route("PGlite", "deleteMany", {
      where: { name: "Alpha" },
      limit: 1,
    });
    expect(routed.compile({}).steps).toHaveLength(1);
  });
});

describe("the per-dialect spelling of a nonzero limit", () => {
  test("MySQL caps with a native LIMIT and no PK subquery", () => {
    for (const operation of ["updateMany", "deleteMany"] as const) {
      const routed = route("MySQL2", operation, {
        where: { name: "Alpha" },
        ...(operation === "updateMany" ? { data: { qty: 1 } } : {}),
        limit: 3,
      });
      const statement = sqlOf(routed.compile({}).steps[0]!);
      // Inlined, not bound: MySQL's own clause builder inlines integer limits.
      expect(statement).toContain("LIMIT 3");
      expect(statement).not.toMatch(PK_SUBQUERY);
    }
  });

  for (const driverName of ["PGlite", "SQLite3"] as const) {
    test(`${driverName} caps with a PK subquery and no native LIMIT on the write`, () => {
      for (const operation of ["updateMany", "deleteMany"] as const) {
        const routed = route(driverName, operation, {
          where: { name: "Alpha" },
          ...(operation === "updateMany" ? { data: { qty: 1 } } : {}),
          limit: 3,
        });
        const statement = sqlOf(routed.compile({}).steps[0]!);
        expect(statement).toMatch(PK_SUBQUERY);
        // The only LIMIT is the one inside the subquery.
        expect(statement.split("IN (SELECT")[0]).not.toMatch(NATIVE_LIMIT);
      }
    });
  }

  test("the control: no limit means neither form appears", () => {
    for (const driverName of ["PGlite", "SQLite3", "MySQL2"] as const) {
      const statement = sqlOf(
        route(driverName, "deleteMany", { where: { name: "Alpha" } }).compile(
          {}
        ).steps[0]!
      );
      expect(statement).not.toMatch(NATIVE_LIMIT);
      expect(statement).not.toMatch(PK_SUBQUERY);
    }
  });
});

/**
 * On a driver without RETURNING the row-returning arm never uses the native
 * `UPDATE … LIMIT`: the planning capture already decides the affected set, and
 * the write and the re-read both address it by captured primary key. Capping the
 * capture is therefore the whole implementation — and it must be capped, or the
 * write would touch every matching row while only `limit` of them came back.
 */
describe("the non-returning select arm caps its planning capture", () => {
  test("MySQL updateMany with select limits the capture, not the write", () => {
    const routed = route("MySQL2", "updateMany", {
      where: { name: "Alpha" },
      data: { qty: 1 },
      limit: 2,
      select: { id: true, qty: true },
    });

    const planning = routed.planning();
    expect(planning.steps).toHaveLength(1);
    const capture = planning.steps[0]!;
    expect(sqlOf(capture)).toContain("FOR UPDATE");
    expect(sqlOf(capture)).toMatch(NATIVE_LIMIT);

    // Two captured rows: the write addresses exactly those, uncapped.
    const compiled = routed.compile({
      [planningKey(capture.id, "rows")]: [{ id: "g1" }, { id: "g2" }],
    });
    expect(compiled.steps.map((step) => step.kind)).toEqual(["write", "read"]);
    expect(sqlOf(compiled.steps[0]!)).not.toMatch(NATIVE_LIMIT);
  });

  test("the control: without a limit the capture carries no LIMIT", () => {
    const routed = route("MySQL2", "updateMany", {
      where: { name: "Alpha" },
      data: { qty: 1 },
      select: { id: true },
    });
    expect(sqlOf(routed.planning().steps[0]!)).not.toMatch(NATIVE_LIMIT);
  });
});
