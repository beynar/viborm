import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * The JSON null sentinels, at the layer a live database cannot show: the SQL
 * each of the six predicates emits, on every dialect — including MySQL, whose
 * execution leg only runs under Docker.
 *
 * The pinned shapes are what make the truth table PORTABLE. `IS NULL` is the
 * database NULL everywhere; the JSON null is a value comparison against
 * whatever `adapter.json.value(null)` binds, which is the same serialization
 * the write path stores for `JsonNull` — a plain `'null'` parameter cast to
 * the column type by PG, `CAST(? AS JSON)` on MySQL, canonical text on SQLite.
 * If a dialect ever bound a different spelling on one of the two sides, the
 * two nulls would stop being distinguishable there and these tests fail.
 *
 * Execution-backed behavior lives in
 * {@link file://../drivers/json-null-sentinel-behavior.ts} (every driver).
 */

const Doc = s
  .model({
    id: s.string().id(),
    meta: s.json().nullable(),
  })
  .map("json_null_sql_docs");

const schema = { Doc };

beforeAll(() => hydrateSchemaNames(schema));

const PATH_WITH_SENTINEL = /cannot combine 'path' with the DbNull sentinel/;

type DialectCase = {
  name: string;
  dialect: Dialect;
  quote: '"' | "`";
  createAdapter: () => DatabaseAdapter;
  /** How the dialect spells the bound JSON-null operand in a comparison. */
  jsonNullOperand: (placeholder: string) => string;
  /** The dialect's inequality operator, as it lands in SQL. */
  notEquals: "!=" | "<>";
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    quote: '"',
    createAdapter: () => new PostgresAdapter(),
    // A plain parameter: PG infers jsonb from the column side of the comparison
    jsonNullOperand: (placeholder) => placeholder,
    notEquals: "<>",
  },
  {
    name: "MySQL",
    dialect: "mysql",
    quote: "`",
    createAdapter: () => new MySQLAdapter(),
    // Without the cast the parameter compares as a JSON *string* scalar
    jsonNullOperand: (placeholder) => `CAST(${placeholder} AS JSON)`,
    notEquals: "<>",
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    quote: '"',
    createAdapter: () => new SQLiteAdapter(),
    jsonNullOperand: (placeholder) => placeholder,
    notEquals: "<>",
  },
];

function createEngine(dialectCase: DialectCase): QueryEngine {
  const adapter = dialectCase.createAdapter();
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(
    new SqlOnlyDriver(adapter, dialectCase.dialect),
    registry
  );
}

function build(
  dialectCase: DialectCase,
  operation: string,
  args: Record<string, unknown>
): { statement: string; values: unknown[] } {
  const query = createEngine(dialectCase).build(
    Doc,
    operation as never,
    args as never
  );
  return { statement: query.toStatement("?"), values: query.values };
}

function predicateOf(statement: string): string {
  return statement.slice(statement.indexOf("WHERE"));
}

describe.each(dialectCases)("$name json null sentinel SQL", (dialectCase) => {
  const q = (identifier: string) =>
    `${dialectCase.quote}${identifier}${dialectCase.quote}`;
  const jsonNull = dialectCase.jsonNullOperand("?");
  const notEquals = dialectCase.notEquals;

  const wherePredicate = (where: Record<string, unknown>) => {
    const query = build(dialectCase, "findMany", { where });
    return { predicate: predicateOf(query.statement), values: query.values };
  };

  /**
   * The canonical JSON text a dialect's bound operand carries. PostgreSQL
   * binds a `JsonParameter` (src/sql/json-parameter.ts) so a transport can
   * tell a JSON document from an ordinary string; MySQL and SQLite bind the
   * text itself.
   */
  const jsonTexts = (values: readonly unknown[]): string[] =>
    values.map((value) => String(value));

  test("equals DbNull is IS NULL and binds nothing", () => {
    const { predicate, values } = wherePredicate({
      meta: { equals: DbNull },
    });
    expect(predicate).toContain(`${q("meta")} IS NULL`);
    expect(values).toEqual([]);
  });

  test("equals JsonNull compares against the serialized JSON null", () => {
    const { predicate, values } = wherePredicate({
      meta: { equals: JsonNull },
    });
    expect(predicate).toContain(`${q("meta")} = ${jsonNull}`);
    expect(jsonTexts(values)).toEqual(["null"]);
  });

  test("equals AnyNull is the disjunction of the two", () => {
    const { predicate, values } = wherePredicate({
      meta: { equals: AnyNull },
    });
    expect(predicate).toContain(`${q("meta")} IS NULL`);
    expect(predicate).toContain(`${q("meta")} = ${jsonNull}`);
    expect(predicate).toContain(" OR ");
    expect(jsonTexts(values)).toEqual(["null"]);
  });

  test("not DbNull is IS NOT NULL", () => {
    const { predicate, values } = wherePredicate({ meta: { not: DbNull } });
    expect(predicate).toContain(`${q("meta")} IS NOT NULL`);
    expect(values).toEqual([]);
  });

  test("not JsonNull is a value inequality", () => {
    const { predicate, values } = wherePredicate({ meta: { not: JsonNull } });
    expect(predicate).toContain(`${q("meta")} ${notEquals} ${jsonNull}`);
    expect(jsonTexts(values)).toEqual(["null"]);
  });

  test("not AnyNull is the conjunction of both complements", () => {
    const { predicate, values } = wherePredicate({ meta: { not: AnyNull } });
    expect(predicate).toContain(`${q("meta")} IS NOT NULL`);
    expect(predicate).toContain(`${q("meta")} ${notEquals} ${jsonNull}`);
    expect(predicate).toContain(" AND ");
    expect(jsonTexts(values)).toEqual(["null"]);
  });

  /**
   * The write side and the filter side must agree on ONE serialization of the
   * JSON null, or a row written with `JsonNull` would not be found by
   * `equals: JsonNull` on that dialect. `create`/`update` are operation
   * PROGRAMS rather than single statements, so the coupling is pinned where it
   * actually lives: the two adapter primitives the two paths call
   * (`buildScalarSqlValue` -> `literals.json`, the filter -> `json.value`).
   * Execution proves the rest, per driver, in the behavior suite.
   */
  test("the write serialization of JsonNull is the one filters compare", () => {
    const adapter = dialectCase.createAdapter();

    const written = adapter.literals.json(null);
    expect(jsonTexts(written.values)).toEqual(["null"]);

    const compared = adapter.json.value(null);
    expect(jsonTexts(compared.values)).toEqual(["null"]);
    expect(compared.toStatement("?")).toBe(jsonNull);
  });

  test("DbNull lowers to a SQL NULL literal, bound to nothing", () => {
    const nullLiteral = dialectCase.createAdapter().literals.null();
    expect(nullLiteral.toStatement("?")).toBe("NULL");
    expect(nullLiteral.values).toEqual([]);
  });

  test("a sentinel under a path is refused before SQL exists", () => {
    expect(() =>
      build(dialectCase, "findMany", {
        where: { meta: { path: ["a"], equals: DbNull } },
      })
    ).toThrow(PATH_WITH_SENTINEL);
  });

  // The pinned pre-sentinel answers, per dialect: a bare `null` still means
  // the SQL NULL at the root and the JSON null under a path.
  test("a bare null keeps its pre-sentinel meaning", () => {
    const root = wherePredicate({ meta: { equals: null } });
    expect(root.predicate).toContain(`${q("meta")} IS NULL`);
    expect(root.values).toEqual([]);

    const scoped = build(dialectCase, "findMany", {
      where: { meta: { path: ["a"], equals: null } },
    });
    expect(jsonTexts(scoped.values)).toContain("null");
  });
});
