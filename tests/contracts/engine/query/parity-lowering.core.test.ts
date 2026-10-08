import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Lane Q / U2 — what a lowered statement means.
 *
 * The 18 relation-filtered mutation cells this restores are behavioural and
 * live in the provider suites; what cannot be seen there is the SQL that made
 * them wrong, and the MySQL 1093 wrap that only a dialect without a live
 * server can be asked about. These are the deleted `sql-generation` pins,
 * re-added one-sided: the qualifier must be there, the wrap must be there on
 * MySQL and nowhere else.
 */

class LoweringDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;
  readonly statements: string[] = [];
  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `parity-lowering-${dialect}`);
    this.adapter = adapter;
  }
  protected async initClient() {
    return null;
  }
  protected async closeClient() {
    // Lowering only.
  }
  protected async execute<T>(
    _client: null,
    statement: string
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.statements.push(statement);
    return { rows: [], rowCount: 0 };
  }
  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }
  protected async transaction<T>(
    _client: null,
    fn: (client: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const employee = s
  .model({
    id: s.string().id(),
    name: s.string(),
    views: s.int(),
    managerId: s.string().nullable(),
    manager: s
      .toOne(() => employee)
      .fields("managerId")
      .references("id"),
    reports: s.toMany(() => employee),
    location: s.point().nullable(),
    embedding: s.vector().dimension(3),
    metadata: s.json().nullable(),
  })
  .map("parity_lowering_employees");

/**
 * A compound key whose constraint lists its fields in the other order than the
 * model declares them: key order is the declaration order (`row`, then `col`),
 * the order a read's `take` completes with.
 */
const seat = s
  .model({
    row: s.int(),
    col: s.int(),
    label: s.string(),
  })
  .id(["col", "row"])
  .map("parity_lowering_seats");

const schema = { employee, seat };
beforeAll(() => hydrateSchemaNames(schema));

const paris = { longitude: 2.3522, latitude: 48.8566 };

/** The derived-table wrap MySQL needs and no other dialect may have. */
const DERIVED_TABLE_WRAP = /EXISTS\s*\(\s*SELECT \* FROM \(/;

function engineOf(adapter: DatabaseAdapter, dialect: Dialect): TestQueryEngine {
  return new TestQueryEngine(
    new LoweringDriver(adapter, dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
}

function build(
  adapter: DatabaseAdapter,
  dialect: Dialect,
  operation: string,
  args: Record<string, unknown>,
  model: Model<any> = employee
): string {
  return engineOf(adapter, dialect)
    .build(model, operation as never, args as never)
    .toStatement("?");
}

type DialectCase = {
  name: string;
  dialect: Dialect;
  adapter: () => DatabaseAdapter;
  /** How the dialect quotes an identifier. */
  q: (name: string) => string;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    adapter: () => new PostgresAdapter("public", true),
    q: (name) => `"${name}"`,
  },
  {
    name: "MySQL",
    dialect: "mysql",
    adapter: () => new MySQLAdapter(),
    q: (name) => `\`${name}\``,
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    adapter: () => new SQLiteAdapter(),
    q: (name) => `"${name}"`,
  },
];

/**
 * A write does not compile to one statement through `build()`, so the
 * mutation cells read what the driver was ASKED to run.
 */
function loweringClient(dialectCase: DialectCase) {
  const driver = new LoweringDriver(dialectCase.adapter(), dialectCase.dialect);
  return { driver, client: createClient({ schema, driver }) };
}

describe.each(dialectCases)("$name mutation correlation", (dialectCase) => {
  const table = dialectCase.q("parity_lowering_employees");
  const qualified = `${table}.${dialectCase.q("id")}`;

  test("an unaliased mutation target is correlated by its table NAME", async () => {
    const { driver, client } = loweringClient(dialectCase);
    await client.employee.updateMany({
      where: { reports: { some: { name: "mid" } } },
      data: { name: "boss" },
    });
    await client.$disconnect();
    const update = driver.statements.find((statement) =>
      statement.startsWith("UPDATE")
    );
    // The parent key inside the EXISTS must name the mutated table: a bare
    // "id" binds to the CHILD in a self relation and the EXISTS is empty.
    expect(update).toContain("EXISTS");
    expect(update).toContain(qualified);
  });

  test("the same qualifier reaches deleteMany", async () => {
    const { driver, client } = loweringClient(dialectCase);
    await client.employee.deleteMany({
      where: { reports: { none: { name: "mid" } } },
    });
    await client.$disconnect();
    const remove = driver.statements.find((statement) =>
      statement.startsWith("DELETE")
    );
    expect(remove).toContain(qualified);
  });

  test("a subquery over the mutated table is hidden only where the provider needs it", async () => {
    const { driver, client } = loweringClient(dialectCase);
    await client.employee.updateMany({
      where: { reports: { some: { name: "mid" } } },
      data: { name: "boss" },
    });
    await client.$disconnect();
    const update =
      driver.statements.find((statement) => statement.startsWith("UPDATE")) ??
      "";
    // MySQL ERROR 1093: a subquery may not read the table being mutated.
    const wrapped = DERIVED_TABLE_WRAP.test(update);
    expect(wrapped).toBe(dialectCase.dialect === "mysql");
  });
});

/**
 * A limited `deleteMany`/`updateMany` takes the first `limit` rows in key
 * order, the order a read's `take` completes with (owner ruling, 2026-10-02):
 * PostgreSQL/SQLite recheck candidates outside their ordered keyed subquery;
 * MySQL retains the predicate on its native ordered LIMIT mutation. The compound key is
 * ordered in declaration order (`row`, `col`), not in its constraint's. MySQL
 * cannot execute here: its text is the only witness of its spelling.
 */
const LIMITED_WRITES: Record<string, readonly string[]> = {
  PostgreSQL: [
    'DELETE FROM "public"."parity_lowering_employees" WHERE ("parity_lowering_employees"."views" > $1 AND "id" IN (SELECT "q0"."id" FROM "public"."parity_lowering_employees" AS "q0" WHERE "q0"."views" > $2 ORDER BY "q0"."id" ASC LIMIT $3))',
    'UPDATE "public"."parity_lowering_employees" SET "name" = $1 WHERE ("parity_lowering_employees"."views" > $2 AND "id" IN (SELECT "q0"."id" FROM "public"."parity_lowering_employees" AS "q0" WHERE "q0"."views" > $3 ORDER BY "q0"."id" ASC LIMIT $4))',
    'DELETE FROM "public"."parity_lowering_employees" WHERE (EXISTS (SELECT 1 FROM "public"."parity_lowering_employees" AS "q0" WHERE ("parity_lowering_employees"."id" = "q0"."managerId" AND "q0"."name" = $1)) AND "id" IN (SELECT "q1"."id" FROM "public"."parity_lowering_employees" AS "q1" WHERE EXISTS (SELECT 1 FROM "public"."parity_lowering_employees" AS "q2" WHERE ("q1"."id" = "q2"."managerId" AND "q2"."name" = $2)) ORDER BY "q1"."id" ASC LIMIT $3))',
    'DELETE FROM "public"."parity_lowering_seats" WHERE ("parity_lowering_seats"."label" = $1 AND ("row", "col") IN (SELECT "q0"."row", "q0"."col" FROM "public"."parity_lowering_seats" AS "q0" WHERE "q0"."label" = $2 ORDER BY "q0"."row" ASC, "q0"."col" ASC LIMIT $3))',
    'UPDATE "public"."parity_lowering_seats" SET "label" = $1 WHERE ("parity_lowering_seats"."label" = $2 AND ("row", "col") IN (SELECT "q0"."row", "q0"."col" FROM "public"."parity_lowering_seats" AS "q0" WHERE "q0"."label" = $3 ORDER BY "q0"."row" ASC, "q0"."col" ASC LIMIT $4))',
  ],
  MySQL: [
    "DELETE FROM `parity_lowering_employees` WHERE `parity_lowering_employees`.`views` > ? ORDER BY `id` ASC LIMIT 2",
    "UPDATE `parity_lowering_employees` SET `name` = ? WHERE `parity_lowering_employees`.`views` > ? ORDER BY `id` ASC LIMIT 2",
    "DELETE FROM `parity_lowering_employees` WHERE EXISTS (SELECT * FROM (SELECT 1 FROM `parity_lowering_employees` AS `q0` WHERE (`parity_lowering_employees`.`id` = `q0`.`managerId` AND (`q0`.`name` = ? AND BINARY `q0`.`name` = ?))) AS `q1`) ORDER BY `id` ASC LIMIT 2",
    "DELETE FROM `parity_lowering_seats` WHERE (`parity_lowering_seats`.`label` = ? AND BINARY `parity_lowering_seats`.`label` = ?) ORDER BY `row` ASC, `col` ASC LIMIT 2",
    "UPDATE `parity_lowering_seats` SET `label` = ? WHERE (`parity_lowering_seats`.`label` = ? AND BINARY `parity_lowering_seats`.`label` = ?) ORDER BY `row` ASC, `col` ASC LIMIT 2",
  ],
  SQLite: [
    'DELETE FROM "parity_lowering_employees" WHERE ("parity_lowering_employees"."views" > ? AND "id" IN (SELECT "q0"."id" FROM "parity_lowering_employees" AS "q0" WHERE "q0"."views" > ? ORDER BY "q0"."id" ASC LIMIT ?))',
    'UPDATE "parity_lowering_employees" SET "name" = ? WHERE ("parity_lowering_employees"."views" > ? AND "id" IN (SELECT "q0"."id" FROM "parity_lowering_employees" AS "q0" WHERE "q0"."views" > ? ORDER BY "q0"."id" ASC LIMIT ?))',
    'DELETE FROM "parity_lowering_employees" WHERE (EXISTS (SELECT 1 FROM "parity_lowering_employees" AS "q0" WHERE ("parity_lowering_employees"."id" = "q0"."managerId" AND "q0"."name" COLLATE BINARY = ?)) AND "id" IN (SELECT "q1"."id" FROM "parity_lowering_employees" AS "q1" WHERE EXISTS (SELECT 1 FROM "parity_lowering_employees" AS "q2" WHERE ("q1"."id" = "q2"."managerId" AND "q2"."name" COLLATE BINARY = ?)) ORDER BY "q1"."id" ASC LIMIT ?))',
    'DELETE FROM "parity_lowering_seats" WHERE ("parity_lowering_seats"."label" COLLATE BINARY = ? AND ("row", "col") IN (SELECT "q0"."row", "q0"."col" FROM "parity_lowering_seats" AS "q0" WHERE "q0"."label" COLLATE BINARY = ? ORDER BY "q0"."row" ASC, "q0"."col" ASC LIMIT ?))',
    'UPDATE "parity_lowering_seats" SET "label" = ? WHERE ("parity_lowering_seats"."label" COLLATE BINARY = ? AND ("row", "col") IN (SELECT "q0"."row", "q0"."col" FROM "parity_lowering_seats" AS "q0" WHERE "q0"."label" COLLATE BINARY = ? ORDER BY "q0"."row" ASC, "q0"."col" ASC LIMIT ?))',
  ],
};

describe.each(dialectCases)("$name limited writes", (dialectCase) => {
  test("take the first `limit` rows in key order", async () => {
    const { driver, client } = loweringClient(dialectCase);
    await client.employee.deleteMany({ where: { views: { gt: 0 } }, limit: 2 });
    await client.employee.updateMany({
      where: { views: { gt: 0 } },
      data: { name: "x" },
      limit: 2,
    });
    // A relation filter: MySQL hides the mutated table (ERROR 1093) AND
    // orders the statement.
    await client.employee.deleteMany({
      where: { reports: { some: { name: "mid" } } },
      limit: 2,
    });
    await client.seat.deleteMany({ where: { label: "a" }, limit: 2 });
    await client.seat.updateMany({
      where: { label: "a" },
      data: { label: "b" },
      limit: 2,
    });
    await client.$disconnect();
    expect(driver.statements).toEqual(LIMITED_WRITES[dialectCase.name]);
  });

  // A batch-prepared limited soft delete states its window as a predicate,
  // read by the premise's SELECT and by the UPDATE over the same table.
  // MySQL refuses both a LIMIT inside IN (…) and a subquery reading the
  // updated table: there the limited read is a derived table.
  test("a window's limited read is a derived table where the provider needs one", () => {
    const queries = new Queries(
      new EngineSchema(schema),
      dialectCase.adapter()
    );
    const selector = queries.prepareSelector(employee, {
      views: { gt: 0 },
    });
    const window = queries.lowerSelector(queries.window(selector, 2))!;
    const derived = window.toStatement("?").includes("SELECT * FROM (SELECT");
    expect(derived).toBe(dialectCase.name === "MySQL");
  });
});

describe("operand and order lowering", () => {
  const postgres = () => new PostgresAdapter("public", true);

  test("a raw Sql operand is ONE operand", () => {
    const statement = build(postgres(), "postgresql", "findMany", {
      where: {
        views: {
          gte: (ctx: { sql: (parts: TemplateStringsArray) => unknown }) =>
            ctx.sql`SELECT MAX(views) FROM parity_lowering_employees`,
        },
      },
    });
    expect(statement).toContain(
      ">= (SELECT MAX(views) FROM parity_lowering_employees)"
    );
  });

  test("a cursor over a vector distance raises the CURSOR refusal, not the provider's", () => {
    for (const dialectCase of dialectCases) {
      expect(() =>
        build(dialectCase.adapter(), dialectCase.dialect, "findMany", {
          take: 2,
          cursor: { id: "e1" },
          orderBy: {
            embedding: {
              _distance: { to: [1, 2, 3], metric: "l2", sort: "asc" },
            },
          },
        })
      ).toThrow(
        "Cursor pagination supports direct scalar sort directions only"
      );
    }
  });

  test("…and raises the same refusal where the provider DOES support vectors", () => {
    const adapter = postgres();
    adapter.capabilities.supportsVector = true;
    expect(() =>
      build(adapter, "postgresql", "findMany", {
        take: 2,
        cursor: { id: "e1" },
        orderBy: {
          embedding: {
            _distance: { to: [1, 2, 3], metric: "l2", sort: "asc" },
          },
        },
      })
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
    // The same order without a cursor still lowers on that provider.
    expect(
      build(adapter, "postgresql", "findMany", {
        orderBy: {
          embedding: {
            _distance: { to: [1, 2, 3], metric: "l2", sort: "asc" },
          },
        },
      })
    ).toContain("ORDER BY");
  });
});

describe("the bounded distance index probe", () => {
  const cases: DialectCase[] = dialectCases.filter(
    (dialectCase) => dialectCase.dialect !== "sqlite"
  );

  // Bounds now combine a conservative spatial index probe with exact
  // coordinate guards. The distance conjunction can group those guards
  // differently from a standalone within filter; the index predicate itself
  // must remain present only in positive bounded distance filters.
  const probed = (statement: string, dialectCase: DialectCase): boolean =>
    statement.includes(
      dialectCase.dialect === "postgresql"
        ? "&& ST_SetSRID(ST_GeomFromGeoJSON"
        : "MBRIntersects("
    );

  test.each(
    cases
  )("$name probes a bounded positive distance", (dialectCase) => {
    const bounded = build(
      dialectCase.adapter(),
      dialectCase.dialect,
      "findMany",
      {
        where: { location: { distance: { to: paris, lte: 1000 } } },
      }
    );
    expect(probed(bounded, dialectCase)).toBe(true);
  });

  test.each(cases)("$name does not probe a LOWER bound", (dialectCase) => {
    const lower = build(
      dialectCase.adapter(),
      dialectCase.dialect,
      "findMany",
      {
        where: { location: { distance: { to: paris, gte: 1000 } } },
      }
    );
    expect(probed(lower, dialectCase)).toBe(false);
  });

  test.each(cases)("$name does not probe under a negation", (dialectCase) => {
    // NOT(box ∧ distance ≤ X) is not NOT(distance ≤ X): a conjunct added to a
    // negated predicate changes the answer.
    const negated = build(
      dialectCase.adapter(),
      dialectCase.dialect,
      "findMany",
      {
        where: { NOT: { location: { distance: { to: paris, lte: 1000 } } } },
      }
    );
    expect(probed(negated, dialectCase)).toBe(false);
    const inner = build(
      dialectCase.adapter(),
      dialectCase.dialect,
      "findMany",
      {
        where: {
          reports: {
            none: { location: { distance: { to: paris, lte: 1000 } } },
          },
        },
      }
    );
    expect(probed(inner, dialectCase)).toBe(false);
  });
});

describe("JSON mode precedence (D-22)", () => {
  /** How many arms of one statement fold case. */
  const folds = (statement: string) => statement.split("lower(").length - 1;

  const jsonStatement = (inner: Record<string, unknown>) =>
    build(new SQLiteAdapter(), "sqlite", "findMany", {
      where: {
        metadata: {
          mode: "insensitive",
          string_contains: "ark",
          not: { string_contains: "ight", ...inner },
        },
      },
    });

  const scalarStatement = (inner: Record<string, unknown>) =>
    build(new SQLiteAdapter(), "sqlite", "findMany", {
      where: {
        name: {
          contains: "a",
          mode: "insensitive",
          not: { contains: "b", ...inner },
        },
      },
    });

  // The decided rule is an ASYMMETRY, so each cell measures the DIFFERENCE a
  // declared `default` makes: pinning that `lower(` merely appears is true of
  // the upgrade-only rule D-22 replaced, and would not redden if the arm were
  // lowered back to it.
  test("a JSON filter's own `default` wins against the inherited mode", () => {
    const reset = jsonStatement({ mode: "default" });
    const inherited = jsonStatement({});
    expect(inherited).toContain("lower(");
    expect(reset).not.toBe(inherited);
    expect(folds(reset)).toBeLessThan(folds(inherited));
    expect(reset).toContain("NOT");
  });

  test("a scalar filter's `default` changes nothing — its mode may only upgrade", () => {
    const reset = scalarStatement({ mode: "default" });
    const inherited = scalarStatement({});
    expect(inherited).toContain("lower(");
    expect(reset).toBe(inherited);
    expect(folds(reset)).toBe(folds(inherited));
  });
});
