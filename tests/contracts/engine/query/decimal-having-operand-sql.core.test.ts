/**
 * A decimal `having` operand is lowered in the column's own domain.
 *
 * `where: { amount: { gt: 5 } }` binds its operand through the dialect's
 * DECIMAL literal — `CAST(? AS DECIMAL(p,s))` on MySQL, `CAST(? AS NUMERIC(p,s))`
 * on PostgreSQL, `CAST(? AS INTEGER)` over the unscaled coefficient on SQLite —
 * so the comparison happens in the exact domain the column is stored in.
 * `having: { amount: { _max: { gt: 5 } } }` asks the SAME ordered question
 * about the SAME column and therefore has to bind the same way. It did not:
 * it used `literals.value`, which leaves MySQL comparing a `DECIMAL` column
 * against a non-decimal operand — and MySQL resolves that comparison as
 * floating point, so the COLUMN side is rounded to a double before the
 * comparison, whatever the operand's own precision. On SQLite an uncast operand
 * is worse still: the column holds an integer coefficient, so a logical operand
 * compares against a number a hundred times larger.
 *
 * The operand is no longer typed as a JavaScript double either — the aggregate
 * filter of a decimal field takes decimal operands, and `_sum` takes them in
 * the WIDENED domain, because a sum may legitimately exceed the field's
 * precision while keeping its scale. That is asserted here as a lowering
 * equality rather than as rows, because the dialect-level property — "the
 * having operand is lowered exactly as the where operand is" — is what has to
 * stay true and it is checkable with no database at all.
 *
 * Each assertion is written as an EQUALITY against the `where` lowering rather
 * than against a hardcoded cast string, so it states the invariant instead of a
 * dialect spelling, and holds when a dialect's literal changes.
 *
 * `_count` is the deliberate exception: it compares a row count, not a value in
 * the column's domain, so casting it to the decimal domain would be wrong. It is
 * asserted to bind as a plain parameter.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

const ledger = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal({ precision: 16, scale: 2 }),
    amounts: s.decimal({ precision: 16, scale: 2 }).array(),
  })
  .map("decimal_having_sql_ledger");

const schema = { ledger };

/**
 * `bound` is what the dialect actually sends for the logical operand `5`: the
 * canonical logical text where the column stores a logical decimal, and the
 * unscaled coefficient where it stores an integer. Stating it per dialect is
 * what keeps SQLite honest — an assertion of `"5"` everywhere would pass while
 * SQLite compared `5` against coefficients a hundred times larger.
 */
const dialects = [
  {
    name: "PostgreSQL",
    dialect: "postgresql" as Dialect,
    adapter: () => new PostgresAdapter(),
    bound: ["5"],
    boundList: ["5", "6"],
    listProjection: 'CAST("t0"."amounts" AS TEXT[]) AS "amounts"',
    groupedList: '"t0"."amounts"',
  },
  {
    name: "MySQL",
    dialect: "mysql" as Dialect,
    adapter: () => new MySQLAdapter(),
    bound: ["5"],
    boundList: ["5", "6"],
    listProjection: "CAST(`t0`.`amounts` AS CHAR) AS `amounts`",
    groupedList: "`t0`.`amounts`",
  },
  {
    name: "SQLite",
    dialect: "sqlite" as Dialect,
    adapter: () => new SQLiteAdapter(),
    bound: ["500"],
    boundList: ["500", "600"],
    listProjection: 'CAST("t0"."amounts" AS TEXT) AS "amounts"',
    groupedList: '"t0"."amounts"',
  },
];

/** A bare bound parameter, i.e. NOT routed through a domain literal. */
const BARE_PARAMETER_REGEX = /^\$\d+$/;

/** The descriptor refusal's own sentence, from the one codec that writes it. */
const EXCESS_SCALE_REFUSAL = /fractional digit/;

/** The provider-bounded widened-sum refusal from the generic query boundary. */
const SUM_DOMAIN_REFUSAL =
  /outside this provider's exact HAVING operand cast domain/;

/** Everything from the sort direction onward, so only the expression is left. */
const SORT_DIRECTION_TAIL = / (ASC|DESC).*$/;

beforeAll(() => hydrateSchemaNames(schema));

type Built = { statement: string; values: unknown[] };

const build = (
  adapter: DatabaseAdapter,
  dialect: Dialect,
  operation: Operation,
  args: Record<string, unknown>
): Built => {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new QueryEngine(new SqlOnlyDriver(adapter, dialect), registry);
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

describe("SQLite widened decimal sum operand range", () => {
  const buildOperand = (operand: string) =>
    build(new SQLiteAdapter(), "sqlite", "groupBy", {
      by: ["bucket"],
      having: { amount: { _sum: { gt: operand } } },
      _count: true,
    });

  test("admits every pinned in-range 19-digit coefficient", () => {
    const admitted = [
      {
        logical: "15000000000000000.00",
        coefficient: "1500000000000000000",
      },
      {
        logical: "-15000000000000000.00",
        coefficient: "-1500000000000000000",
      },
      {
        logical: "92233720368547758.07",
        coefficient: "9223372036854775807",
      },
      {
        logical: "-92233720368547758.08",
        coefficient: "-9223372036854775808",
      },
    ];

    for (const { logical, coefficient } of admitted) {
      const query = buildOperand(logical);
      expect(operandAfter(query.statement, ">")).toContain("CAST(");
      expect(query.values).toEqual([coefficient]);
    }
  });

  test("refuses the first coefficient beyond each signed-int64 endpoint", () => {
    expect(() => buildOperand("92233720368547758.08")).toThrow(
      SUM_DOMAIN_REFUSAL
    );
    expect(() => buildOperand("-92233720368547758.09")).toThrow(
      SUM_DOMAIN_REFUSAL
    );
  });

  test("refuses a very wide coefficient through the same pre-I/O boundary", () => {
    expect(() => buildOperand("9".repeat(10_000))).toThrow(SUM_DOMAIN_REFUSAL);
  });
});

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
    // The number is canonicalized to its exact decimal spelling before binding,
    // and then rendered into the domain the column stores.
    expect(values).toEqual(dialectCase.bound);
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
    expect(having.values).toEqual(dialectCase.boundList);
  });

  test("a _sum operand wider than the field's precision still binds", () => {
    // 16 digits at scale 2 is the field's whole domain, so this operand — an
    // 18-digit coefficient — is two digits past what any single row can hold,
    // and a legitimate sum of rows. Held to the field's SCALE (two fractional
    // digits) and to nothing else the field declares.
    const wide = "9999999999999999.99";
    const having = buildHere("groupBy", {
      by: ["bucket"],
      having: { amount: { _sum: { gt: wide } } },
      _count: true,
    });

    expect(operandAfter(having.statement, ">")).toContain("CAST(");
    expect(having.values).toEqual([
      dialectCase.dialect === "sqlite" ? "999999999999999999" : wide,
    ]);
  });

  test("a _sum operand past the provider's exact cast domain is refused pre-I/O", async () => {
    // Widened is not unbounded. This 19-digit coefficient is above SQLite's
    // signed-int64 maximum, so `CAST(... AS INTEGER)` would saturate without a
    // word and the comparison would answer about a different number. Other
    // 19-digit coefficients do fit; exact endpoint controls live below.
    // PostgreSQL (1000 digits) and MySQL (65) hold it, so the same operand
    // binds there: the bound is the provider's, not the field's.
    const past = "99999999999999999.99";
    const build = () =>
      buildHere("groupBy", {
        by: ["bucket"],
        having: { amount: { _sum: { gt: past } } },
        _count: true,
      });

    if (dialectCase.dialect === "sqlite") {
      await expect(Promise.resolve().then(build)).rejects.toThrow(
        SUM_DOMAIN_REFUSAL
      );
      return;
    }
    expect(build().values).toEqual([past]);
  });

  test("the widened _sum operand stops at the provider's exact cast boundary", async () => {
    const sixtyFiveDigits = `${"9".repeat(63)}.99`;
    const sixtySixDigits = `${"9".repeat(64)}.99`;
    const buildOperand = (operand: string) =>
      buildHere("groupBy", {
        by: ["bucket"],
        having: { amount: { _sum: { gt: operand } } },
        _count: true,
      });

    if (dialectCase.dialect === "postgresql") {
      expect(buildOperand(sixtyFiveDigits).values).toEqual([sixtyFiveDigits]);
      expect(buildOperand(sixtySixDigits).values).toEqual([sixtySixDigits]);
      return;
    }

    if (dialectCase.dialect === "mysql") {
      expect(buildOperand(sixtyFiveDigits).values).toEqual([sixtyFiveDigits]);
      await expect(
        Promise.resolve().then(() => buildOperand(sixtySixDigits))
      ).rejects.toThrow(SUM_DOMAIN_REFUSAL);
      return;
    }

    await expect(
      Promise.resolve().then(() => buildOperand(sixtyFiveDigits))
    ).rejects.toThrow(SUM_DOMAIN_REFUSAL);
    await expect(
      Promise.resolve().then(() => buildOperand(sixtySixDigits))
    ).rejects.toThrow(SUM_DOMAIN_REFUSAL);
  });

  /**
   * `_avg` is the one aggregate whose SQL is not the provider's function.
   *
   * `AVG()` is a double on SQLite and picks its own result scale on the other
   * two, so a decimal average is derived from the exact `SUM` over
   * `COUNT(column)` and quantized half to even. Three places emit it — the
   * projection, `ORDER BY` an aggregate, and `HAVING` — and they must emit the
   * SAME expression, or the ordered answer, the filtered answer and the
   * returned answer are three different numbers.
   *
   * The discriminator is structural rather than a byte pin: the exact form is
   * built from `SUM` and `COUNT` and contains no `AVG(` at all, so substituting
   * `adapter.aggregates.avg(column)` at any of the three sites reds this.
   */
  const clauseBetween = (statement: string, open: string, close?: string) => {
    const start = statement.indexOf(open);
    if (start < 0) throw new Error(`No '${open}' in statement: ${statement}`);
    const from = start + open.length;
    const end = close ? statement.indexOf(close, from) : -1;
    return statement.slice(from, end < 0 ? undefined : end);
  };

  test("grouped decimal lists project through their transport but group on the physical column", () => {
    const grouped = buildHere("groupBy", {
      by: ["amounts"],
      _count: true,
    });
    const projection = clauseBetween(grouped.statement, "SELECT ", " FROM");
    const groupBy = clauseBetween(grouped.statement, "GROUP BY").trim();

    expect(projection).toContain(dialectCase.listProjection);
    expect(groupBy).toBe(dialectCase.groupedList);
    expect(groupBy).not.toContain("CAST(");
  });

  test("groupBy ORDER BY _avg orders by the exact average, not AVG()", () => {
    const ordered = buildHere("groupBy", {
      by: ["bucket"],
      orderBy: { _avg: { amount: "desc" } },
      _avg: { amount: true },
    });
    const orderBy = clauseBetween(ordered.statement, "ORDER BY");

    expect(orderBy).not.toContain("AVG(");
    expect(orderBy).toContain("SUM(");
    expect(orderBy).toContain("COUNT(");
  });

  test("having _avg filters on the exact average, not AVG()", () => {
    const filtered = buildHere("groupBy", {
      by: ["bucket"],
      having: { amount: { _avg: { gt: 5 } } },
      _count: true,
    });
    const having = clauseBetween(filtered.statement, "HAVING", " ORDER BY");

    expect(having).not.toContain("AVG(");
    expect(having).toContain("SUM(");
    expect(having).toContain("COUNT(");
  });

  test("the projection, the ordering and the filter emit ONE expression", () => {
    // The three sites are compared to each other rather than to a spelling: a
    // change that moves all three together stays green, and a change that moves
    // one of them does not.
    const projected = buildHere("groupBy", {
      by: ["bucket"],
      _avg: { amount: true },
    });
    const ordered = buildHere("groupBy", {
      by: ["bucket"],
      orderBy: { _avg: { amount: "desc" } },
      _avg: { amount: true },
    });
    const filtered = buildHere("groupBy", {
      by: ["bucket"],
      having: { amount: { _avg: { gt: 5 } } },
      _count: true,
    });

    // The projection wraps the expression in the result cast; the ordering and
    // the filter do not, so the shared substring is the expression itself.
    const average = clauseBetween(ordered.statement, "ORDER BY")
      .replace(SORT_DIRECTION_TAIL, "")
      .trim();

    expect(average).not.toBe("");
    expect(projected.statement).toContain(average);
    expect(filtered.statement).toContain(average);
  });

  test("a _sum operand finer than the field's scale is refused", async () => {
    // Scale is NOT widened: every summed value carries the field's scale, so a
    // third fractional digit names a number the column cannot produce.
    await expect(
      Promise.resolve().then(() =>
        buildHere("groupBy", {
          by: ["bucket"],
          having: { amount: { _sum: { gt: "1.005" } } },
          _count: true,
        })
      )
    ).rejects.toThrow(EXCESS_SCALE_REFUSAL);
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
