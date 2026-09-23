import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { EMPTY_ROW_RESULT_KEY } from "@query-engine/result-aliases";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * Lane Q / U3 — what a prepared projection and a grouped read must state.
 *
 * The three cases of the shipped `select-builder.ts:418-437` and the two
 * `by`-membership sentences, restored at the preparation owner. The live
 * cardinality half (`[{}, {}]`, `{ children: [{}, {}] }`) is witnessed by the
 * provider suites' `empty default projections` cells; what is pinned here is
 * the STATEMENT those cells could not see and the refusals that never reach a
 * provider at all.
 */

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    category: s.string(),
    posts: s.toMany(() => post),
  })
  .map("parity_preparation_authors");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("parity_preparation_posts");

/** Every scalar omitted at the model level: the default projection is empty. */
const shadow = s
  .model({
    id: s.string().id(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => shadow)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => shadow),
  })
  .omit({ id: true, parentId: true })
  .map("parity_preparation_shadows");

const schema = { author, post, shadow };
beforeAll(() => hydrateSchemaNames(schema));

type DialectCase = {
  name: string;
  dialect: Dialect;
  adapter: () => DatabaseAdapter;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    adapter: () => new PostgresAdapter(),
  },
  { name: "MySQL", dialect: "mysql", adapter: () => new MySQLAdapter() },
  { name: "SQLite", dialect: "sqlite", adapter: () => new SQLiteAdapter() },
];

function build(
  dialectCase: DialectCase,
  model: Model<any>,
  operation: string,
  args: Record<string, unknown>
): string {
  const engine = new QueryEngine(
    new SqlOnlyDriver(dialectCase.adapter(), dialectCase.dialect),
    createModelRegistry(schema, createSchemaRegistry(schema))
  );
  return engine
    .build(model, operation as never, args as never)
    .toStatement("?");
}

describe.each(dialectCases)("$name empty projections", (dialectCase) => {
  test("an explicit empty select is a refusal, not 'everything'", () => {
    expect(() =>
      build(dialectCase, author, "findMany", { select: {} })
    ).toThrow(
      "The 'select' statement for model 'author' needs at least one truthy value."
    );
  });

  test("an all-false select is the same refusal", () => {
    expect(() =>
      build(dialectCase, author, "findMany", {
        select: { id: false, name: false },
      })
    ).toThrow("needs at least one truthy value");
  });

  test("an empty DEFAULT projection takes the sentinel column", () => {
    const statement = build(dialectCase, shadow, "findMany", {});
    expect(statement).toContain(EMPTY_ROW_RESULT_KEY);
    // …and it is a constant, not a column of the row.
    expect(statement).not.toContain("SELECT  FROM");
  });

  test("the sentinel reaches a nested node the same way", () => {
    const statement = build(dialectCase, shadow, "findMany", {
      include: { children: true },
    });
    expect(statement).toContain(EMPTY_ROW_RESULT_KEY);
  });

  test("_count that counts nothing publishes no _count", () => {
    // `post` has no to-many relation, so `_count: true` selects nothing: the
    // shipped engine pushed the pair only when one existed.
    const statement = build(dialectCase, post, "findMany", {
      select: { id: true, _count: true },
    });
    expect(statement).not.toContain("_count");
    // A model that DOES own a to-many still publishes it.
    expect(
      build(dialectCase, author, "findMany", {
        select: { id: true, _count: true },
      })
    ).toContain("_count");
  });

  test("a select that names only an empty _count is still a refusal", () => {
    expect(() =>
      build(dialectCase, post, "findMany", { select: { _count: true } })
    ).toThrow("needs at least one truthy value");
  });
});

describe.each(dialectCases)("$name grouped reads", (dialectCase) => {
  test("a field-keyed having condition must be grouped", () => {
    expect(() =>
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        having: { title: "A1" },
      })
    ).toThrow("Scalar 'title' used in 'having' must be included in 'by'.");
  });

  test("…including inside an OR arm", () => {
    expect(() =>
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        having: { OR: [{ title: "A1" }] },
      })
    ).toThrow("must be included in 'by'");
  });

  test("an aggregate condition on a non-grouped field stays legitimate", () => {
    expect(
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        having: { title: { _count: { gt: 1 } } },
      })
    ).toContain("HAVING");
  });

  test("a non-grouped orderBy column is refused", () => {
    expect(() =>
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        orderBy: { title: "asc" },
      })
    ).toThrow("GroupBy orderBy field 'title' must be included in 'by'");
  });

  test("a grouped orderBy column and an aggregate order both compile", () => {
    expect(
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        orderBy: { authorId: "asc" },
      })
    ).toContain("ORDER BY");
    expect(
      build(dialectCase, post, "groupBy", {
        by: ["authorId"],
        orderBy: { _count: { authorId: "desc" } },
      })
    ).toContain("ORDER BY");
  });

  test("a single by is the same grouped column set", () => {
    expect(build(dialectCase, post, "groupBy", { by: "authorId" })).toContain(
      "GROUP BY"
    );
  });
});
