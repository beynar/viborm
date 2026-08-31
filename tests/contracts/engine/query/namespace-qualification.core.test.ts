/**
 * Read-side database-namespace qualification.
 *
 * ONE renderer owns persistent tables, so a bound adapter must qualify every
 * model and junction table a statement reaches — root, relation target,
 * junction, self junction, variant target, variant member junction and its two
 * inverse views — and NOTHING else. Aliases, columns, relation
 * carrier keys and derived-query names are statement-local and stay bare, and
 * an unbound MySQL or SQLite adapter emits no prefix at all.
 *
 * Structural only: the mock driver opens no provider resource; every statement
 * comes from `QueryEngine.build()`.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import type { Dialect } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames } from "@schema";
import type { Model } from "@schema/model";
import {
  NAMESPACE_SCHEMA_TABLES,
  namespaceSchema,
} from "@tests/fixtures/namespace-schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

hydrateSchemaNames(namespaceSchema);
const registry = createModelRegistry(
  namespaceSchema,
  createSchemaRegistry(namespaceSchema)
);
const { user, post, note, board, article, photo } = namespaceSchema;

type Rendered = { readonly text: string; readonly binds: number };

const renderWith = (
  adapter: DatabaseAdapter,
  dialect: Dialect,
  placeholder: "$n" | "?"
) => {
  const engine = new QueryEngine(new SqlOnlyDriver(adapter, dialect), registry);
  return (
    model: Model<any>,
    operation: Operation,
    args: Record<string, unknown>
  ): Rendered => {
    const statement = engine.build(model, operation, args);
    return {
      text: statement.toStatement(placeholder),
      binds: statement.values.length,
    };
  };
};

const pg = renderWith(new PostgresAdapter("billing"), "postgresql", "$n");
const pgDefault = renderWith(new PostgresAdapter(), "postgresql", "$n");
const pgUnqualifiedControl = renderWith(
  new PostgresAdapter("public"),
  "postgresql",
  "$n"
);
const mysqlBound = renderWith(new MySQLAdapter("billing"), "mysql", "?");
const mysqlUnbound = renderWith(new MySQLAdapter(), "mysql", "?");
const sqlite = renderWith(new SQLiteAdapter(), "sqlite", "?");

const USE_STATEMENT = /\bUSE\b/;
const QUALIFIED_ALIAS = /"billing"\."t\d+"/;

/**
 * Every occurrence of a known table name that is NOT immediately preceded by
 * the namespace prefix. An empty result means the statement reached that
 * object only through the qualified renderer.
 */
const unqualifiedTables = (
  text: string,
  prefix: string,
  quote: '"' | "`"
): string[] => {
  const missed: string[] = [];
  for (const table of NAMESPACE_SCHEMA_TABLES) {
    const quoted = `${quote}${table}${quote}`;
    let index = text.indexOf(quoted);
    while (index !== -1) {
      const after = index + quoted.length;
      // `"ns_posts"."col"` is a column correlated by the target's implicit
      // correlation name, not a table position — see the premise test below.
      const isTablePosition = text[after] !== ".";
      if (isTablePosition && !text.startsWith(prefix, index - prefix.length)) {
        missed.push(table);
      }
      index = text.indexOf(quoted, after);
    }
  }
  return missed;
};

/** The table names a statement mentions at all. */
const mentionedTables = (text: string, quote: '"' | "`"): string[] =>
  NAMESPACE_SCHEMA_TABLES.filter((table) =>
    text.includes(`${quote}${table}${quote}`)
  );

/** How many times a statement names a persistent table in table position. */
const tableMentions = (text: string, quote: '"' | "`"): number => {
  let total = 0;
  for (const table of NAMESPACE_SCHEMA_TABLES) {
    const quoted = `${quote}${table}${quote}`;
    let index = text.indexOf(quoted);
    while (index !== -1) {
      const after = index + quoted.length;
      if (text[after] !== ".") total++;
      index = text.indexOf(quoted, after);
    }
  }
  return total;
};

const READS: ReadonlyArray<
  readonly [string, Model<any>, Operation, Record<string, unknown>]
> = [
  ["findMany", user, "findMany", { select: { id: true, email: true } }],
  ["findUnique", user, "findUnique", { where: { id: "u1" } }],
  [
    "findFirst with a filter",
    post,
    "findFirst",
    { where: { views: { gte: 3 } } },
  ],
  ["count", user, "count", {}],
  ["aggregate", post, "aggregate", { _count: true, _avg: { views: true } }],
  ["groupBy", post, "groupBy", { by: ["authorId"], _count: { id: true } }],
  [
    "ordering",
    post,
    "findMany",
    { orderBy: { views: "desc" }, select: { id: true } },
  ],
  [
    "cursor pagination",
    post,
    "findMany",
    { cursor: { id: "p1" }, orderBy: { id: "asc" }, take: 5 },
  ],
  ["to-one include", post, "findMany", { include: { author: true } }],
  ["to-many include", user, "findMany", { include: { posts: true } }],
  ["junction include", user, "findMany", { include: { tags: true } }],
  ["self junction include", user, "findMany", { include: { follows: true } }],
  [
    "relation filter",
    user,
    "findMany",
    { where: { posts: { some: { title: { equals: "x" } } } } },
  ],
  [
    "junction filter",
    user,
    "findMany",
    { where: { tags: { none: { label: { equals: "x" } } } } },
  ],
  [
    "relation count projection",
    user,
    "findMany",
    { select: { id: true, _count: { select: { posts: true, tags: true } } } },
  ],
  [
    "relation count ordering",
    user,
    "findMany",
    { orderBy: { posts: { _count: "desc" } }, select: { id: true } },
  ],
  [
    "nested include through a junction",
    user,
    "findMany",
    { include: { tags: { include: { users: true } } } },
  ],
  // A NULLABLE sort column is not sargable, so this is the ONLY read shape that
  // takes the general lexicographic cursor branch and its derived cursor row.
  [
    "cursor pagination ordered by a nullable field",
    user,
    "findMany",
    { cursor: { id: "u1" }, orderBy: { age: "desc" }, take: 3 },
  ],
  // Variant carriers — plan §10's "ordinary and VARIANT nested reads, relation
  // filters, counts" and "variant junction paths". The row-held carrier reaches
  // its targets through CASE arms and EXISTS; the collection carrier reaches a
  // member junction per variant, plus the two inverse views those junctions
  // back, plus the membership-first integrity subqueries every arm carries.
  ["variant row include", note, "findMany", { include: { subject: true } }],
  [
    "variant row filter",
    note,
    "findMany",
    {
      where: { subject: { type: "image", is: { url: { equals: "u" } } } },
      select: { id: true },
    },
  ],
  [
    "variant collection include",
    board,
    "findMany",
    { include: { items: true } },
  ],
  [
    "variant collection some",
    board,
    "findMany",
    {
      where: {
        items: { some: { type: "article", is: { title: { equals: "x" } } } },
      },
      select: { id: true },
    },
  ],
  [
    "variant collection every",
    board,
    "findMany",
    {
      where: {
        items: { every: { type: "article", is: { title: { equals: "x" } } } },
      },
      select: { id: true },
    },
  ],
  [
    "variant collection count projection",
    board,
    "findMany",
    { select: { id: true, _count: { select: { items: true } } } },
  ],
  [
    "variant collection count ordering",
    board,
    "findMany",
    { orderBy: { items: { _count: "desc" } }, select: { id: true } },
  ],
  [
    "variant junction plural inverse include",
    photo,
    "findMany",
    { include: { boards: true } },
  ],
  [
    "variant junction singular inverse include",
    article,
    "findMany",
    { include: { board: true } },
  ],
  [
    "variant junction singular inverse ordering",
    article,
    "findMany",
    { orderBy: { board: { id: "asc" } }, select: { id: true } },
  ],
];

describe("a bound PostgreSQL adapter qualifies every persistent table", () => {
  for (const [name, model, operation, args] of READS) {
    test(name, () => {
      const { text } = pg(model, operation, args);
      expect(mentionedTables(text, '"').length).toBeGreaterThan(0);
      expect(unqualifiedTables(text, '"billing".', '"')).toEqual([]);
      expect(text).not.toContain('"billing"."billing"');
    });
  }

  test("the default adapter qualifies with public", () => {
    const { text } = pg(user, "findMany", { include: { tags: true } });
    const { text: defaulted } = pgDefault(user, "findMany", {
      include: { tags: true },
    });
    expect(defaulted).toBe(text.replaceAll('"billing".', '"public".'));
  });
});

describe("a bound MySQL adapter qualifies every persistent table", () => {
  for (const [name, model, operation, args] of READS) {
    test(name, () => {
      const { text } = mysqlBound(model, operation, args);
      expect(unqualifiedTables(text, "`billing`.", "`")).toEqual([]);
      expect(text).not.toContain("`billing`.`billing`");
      expect(text).not.toMatch(USE_STATEMENT);
    });
  }
});

describe("unbound dialects emit no prefix", () => {
  for (const [name, model, operation, args] of READS) {
    test(`unbound MySQL: ${name}`, () => {
      const { text } = mysqlUnbound(model, operation, args);
      const mentions = tableMentions(text, "`");
      expect(mentions).toBeGreaterThan(0);
      // Every mention is unqualified: no prefix precedes any of them.
      expect(unqualifiedTables(text, "`billing`.", "`")).toHaveLength(mentions);
      expect(text).not.toContain("`.`ns_");
    });

    test(`SQLite: ${name}`, () => {
      const { text } = sqlite(model, operation, args);
      const mentions = tableMentions(text, '"');
      expect(mentions).toBeGreaterThan(0);
      expect(unqualifiedTables(text, '"public".', '"')).toHaveLength(mentions);
      expect(text).not.toContain('"."ns_');
    });
  }
});

describe("only persistent tables are qualified", () => {
  const statements = READS.map(([, model, operation, args]) =>
    pg(model, operation, args)
  );

  test("aliases and carrier keys stay bare", () => {
    for (const { text } of statements) {
      expect(text).not.toMatch(QUALIFIED_ALIAS);
      expect(text).not.toContain('"billing"."_json"');
      expect(text).not.toContain('"billing"."_result"');
      expect(text).not.toContain('"billing"."__viborm');
    }
  });

  test("columns stay bare", () => {
    for (const { text } of statements) {
      for (const column of [
        "id",
        "email",
        "title",
        "views",
        "authorId",
        // A variant carrier's PRIVATE pair and a member junction's own
        // reference columns are columns like any other.
        "subject_type",
        "subject_id",
        "boardId",
        "articleId",
        "photoId",
      ]) {
        expect(text).not.toContain(`"billing"."${column}"`);
      }
    }
  });

  test("the only qualified names are the schema's own objects", () => {
    const qualified = new Set<string>();
    for (const { text } of statements) {
      for (const match of text.matchAll(/"billing"\."([^"]+)"/g)) {
        qualified.add(match[1] as string);
      }
    }
    for (const name of qualified) {
      expect(NAMESPACE_SCHEMA_TABLES).toContain(name);
    }
    expect(qualified.size).toBeGreaterThan(0);
  });
});

describe("object names come from the schema, not the namespace", () => {
  test("a .map() name stays a bare object inside the namespace", () => {
    const { text } = pg(user, "findMany", { select: { id: true } });
    expect(text).toContain('FROM "billing"."ns_users" AS "t0"');
    expect(text).not.toContain('"billing_ns_users"');
    expect(text).not.toContain('"ns_users"."');
  });

  test("a generated junction name carries no namespace text", () => {
    const { text } = pg(user, "findMany", { include: { follows: true } });
    for (const match of text.matchAll(/"billing"\."([^"]+)"/g)) {
      expect(match[1]).not.toContain("billing");
    }
  });
});

describe("both cursor spellings qualify the located-row subquery", () => {
  // Cursor pagination has TWO compiled spellings and they are different code:
  // a NOT NULL, single-direction sort compiles to the sargable row-value
  // comparison, and anything else — a nullable sort column here — compiles to
  // the general lexicographic predicate over a DERIVED cursor row. Only the
  // second one renders `__viborm_cursor_N`, so a witness that never orders on a
  // nullable column cannot see its FROM at all.
  test("the sargable and lexicographic branches both name the qualified table", () => {
    const sargable = pg(post, "findMany", {
      cursor: { id: "p1" },
      orderBy: { id: "asc" },
      take: 5,
    }).text;
    const lexicographic = pg(user, "findMany", {
      cursor: { id: "u1" },
      orderBy: { age: "desc" },
      take: 3,
    }).text;

    expect(sargable).not.toContain("__viborm_cursor_0");
    expect(sargable).toContain('FROM "billing"."ns_posts" AS "t1"');

    expect(lexicographic).toContain('AS "__viborm_cursor_0"');
    expect(lexicographic).toContain(
      'FROM "billing"."ns_users" AS "t1" WHERE "t1"."id" = $1 LIMIT $2'
    );
    // The derived cursor row is statement-local and stays bare.
    expect(lexicographic).not.toContain('"billing"."__viborm_cursor_0"');
  });
});

describe("qualification is free", () => {
  test("binds nothing extra on any read", () => {
    for (const [name, model, operation, args] of READS) {
      const bound = pg(model, operation, args);
      const unqualified = pgUnqualifiedControl(model, operation, args);
      expect(`${name}: ${bound.binds}`).toBe(`${name}: ${unqualified.binds}`);
      expect(bound.text).toBe(
        unqualified.text.replaceAll('"public".', '"billing".')
      );
    }
  });

  test("MySQL binds the same values bound and unbound", () => {
    for (const [name, model, operation, args] of READS) {
      expect(`${name}: ${mysqlBound(model, operation, args).binds}`).toBe(
        `${name}: ${mysqlUnbound(model, operation, args).binds}`
      );
    }
  });
});

describe("raw SQL is caller-owned", () => {
  test("a bound adapter does not rewrite raw table text", () => {
    const adapter = new PostgresAdapter("billing");
    const raw = 'SELECT * FROM "ns_users" WHERE "id" = 1';
    expect(adapter.raw(raw).toStatement()).toBe(raw);
  });
});
