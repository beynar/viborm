/**
 * A decimal `having` operand is lowered in the column's own domain.
 *
 * `where: { amount: { gt: 5 } }` binds its operand through the dialect's
 * DECIMAL literal — `CAST(? AS DECIMAL(65,30))` on MySQL, `CAST(? AS NUMERIC)`
 * on PostgreSQL — so the comparison happens in the exact decimal domain.
 * `having: { amount: { _max: { gt: 5 } } }` asks the SAME ordered question
 * about the SAME column and therefore has to bind the same way. It did not:
 * it used `literals.value`, which leaves MySQL comparing a `DECIMAL(65,30)`
 * against a non-decimal operand — and MySQL resolves that comparison as
 * floating point, so the COLUMN side (which may carry 30 digits) is rounded to
 * a double before the comparison, whatever the operand's own precision.
 *
 * That is why this is pinned on the SQL, not on rows: `havingScalarSchema`
 * types an aggregate operand as a finite number, so no operand a caller can
 * spell today is itself past double precision, and the wrong answer needs a
 * stored value past it. The dialect-level property — "the having operand is
 * lowered exactly as the where operand is" — is the thing to keep true, and it
 * is checkable with no database at all.
 *
 * Each assertion is written as an EQUALITY against the `where` lowering rather
 * than against a hardcoded cast string, so it states the invariant instead of a
 * dialect spelling, and holds when a dialect's literal changes.
 *
 * `_count` is the deliberate exception: it compares a row count, not a value in
 * the column's domain, so casting it to DECIMAL would be wrong. It is asserted
 * to bind as a plain parameter.
 *
 * SQLite is absent by construction: it has no exact decimal type, so every
 * ordered decimal aggregate is refused before any SQL is built
 * (tests/query-engine/decimal-refusal-surface.test.ts).
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `decimal-having-sql-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver: no external client is allocated.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const ledger = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal(),
  })
  .map("decimal_having_sql_ledger");

const schema = { ledger };

const dialects = [
  {
    name: "PostgreSQL",
    dialect: "postgresql" as Dialect,
    adapter: () => new PostgresAdapter(),
  },
  {
    name: "MySQL",
    dialect: "mysql" as Dialect,
    adapter: () => new MySQLAdapter(),
  },
];

/** A bare bound parameter, i.e. NOT routed through a domain literal. */
const BARE_PARAMETER_REGEX = /^\$\d+$/;

beforeAll(() => hydrateSchemaNames(schema));

type Built = { statement: string; values: unknown[] };

const build = (
  adapter: DatabaseAdapter,
  dialect: Dialect,
  operation: Operation,
  args: Record<string, unknown>
): Built => {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new QueryEngine(new MockDriver(adapter, dialect), registry);
  const query = engine.build(ledger, operation, args);
  return { statement: query.toStatement("$n"), values: query.values };
};

/**
 * Everything after the LAST comparison operator: the rendered operand.
 *
 * A missing operator throws rather than returning "", so a statement that
 * stopped containing the comparison fails loudly instead of comparing two
 * empty strings and passing.
 */
const operandAfter = (statement: string, operator: string): string => {
  const index = statement.lastIndexOf(`${operator} `);
  if (index < 0) {
    throw new Error(`No '${operator}' comparison in statement: ${statement}`);
  }
  return statement.slice(index + operator.length + 1).trim();
};

describe.each(dialects)("$name decimal having operands", (dialectCase) => {
  const buildHere = (operation: Operation, args: Record<string, unknown>) =>
    build(dialectCase.adapter(), dialectCase.dialect, operation, args);

  /** The reference lowering every decimal comparison must match. */
  const whereOperand = () => {
    const where = buildHere("findMany", {
      where: { amount: { gt: 5 } },
      select: { id: true },
    });
    return {
      rendered: operandAfter(where.statement, ">"),
      values: where.values,
    };
  };

  test("the where operand is itself lowered through the decimal literal", () => {
    const { rendered, values } = whereOperand();

    // Guards the reference: if `where` ever stopped casting, every equality
    // below would still pass while both sides were wrong.
    expect(rendered).not.toMatch(BARE_PARAMETER_REGEX);
    expect(rendered).toContain("CAST(");
    // The number is canonicalized to its exact decimal spelling before binding.
    expect(values).toEqual(["5"]);
  });

  for (const aggregate of ["_min", "_max", "_sum", "_avg"] as const) {
    test(`having ${aggregate} binds its operand exactly as where does`, () => {
      const having = buildHere("groupBy", {
        by: ["bucket"],
        having: { amount: { [aggregate]: { gt: 5 } } },
        _count: true,
      });

      expect(operandAfter(having.statement, ">")).toBe(whereOperand().rendered);
      expect(having.values).toEqual(whereOperand().values);
    });
  }

  test("every element of a having in-list is lowered, not just the first", () => {
    const having = buildHere("groupBy", {
      by: ["bucket"],
      having: { amount: { _sum: { in: [5, 6] } } },
      _count: true,
    });
    const { rendered } = whereOperand();
    // The list renders one lowered operand per element; comparing the count of
    // lowered operands to the element count catches a per-element regression
    // that a "contains CAST" assertion would miss.
    const casts = having.statement.match(/CAST\(/g) ?? [];

    expect(casts).toHaveLength(2);
    expect(rendered).toContain("CAST(");
    expect(having.values).toEqual(["5", "6"]);
  });

  test("having _count compares a row count, so it does NOT get the cast", () => {
    const having = buildHere("groupBy", {
      by: ["bucket"],
      having: { amount: { _count: { gt: 1 } } },
      _count: true,
    });

    expect(operandAfter(having.statement, ">")).toMatch(BARE_PARAMETER_REGEX);
    // A row count is an integer and stays one — no decimal canonicalization.
    expect(having.values).toEqual([1]);
  });
});
