import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { geoBoundsForDistance } from "@validation/primitives/geo-area-codec";
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

const schema = { employee };
beforeAll(() => hydrateSchemaNames(schema));

const paris = { longitude: 2.3522, latitude: 48.8566 };

/** The derived-table wrap MySQL needs and no other dialect may have. */
const DERIVED_TABLE_WRAP = /EXISTS\s*\(\s*SELECT \* FROM \(/;

function engineOf(adapter: DatabaseAdapter, dialect: Dialect): QueryEngine {
  return new QueryEngine(
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

  /**
   * The probe is the adapter's OWN `withinBounds` spelling for the bounding
   * box of the stated upper bound, so the oracle is that same filter compiled
   * on its own — no dialect literal is pinned here.
   */
  const probeSpelling = (dialectCase: DialectCase, meters: number): string => {
    const statement = build(
      dialectCase.adapter(),
      dialectCase.dialect,
      "findMany",
      {
        where: {
          location: { within: { bounds: geoBoundsForDistance(paris, meters) } },
        },
      }
    );
    return statement.slice(statement.indexOf("WHERE ") + "WHERE ".length);
  };

  const probed = (
    statement: string,
    dialectCase: DialectCase,
    meters = 1000
  ): boolean => statement.includes(probeSpelling(dialectCase, meters));

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
