import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import {
  escapeGlobLiteral,
  escapeLikeLiteral,
} from "@adapters/shared/standard-sql";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createModelFieldRefs } from "@schema/field-ref";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

/**
 * The emitted SQL for default-mode `startsWith` (plan Decision 7.3).
 *
 * These are the pins the decision deliberately rewrote. The three dialects do
 * NOT share a spelling, because no single spelling is both exact and
 * index-usable everywhere — the measurements that forced each one are in
 * `docs/architecture/query-performance-plan.md`, §7.3, and repeated in the
 * per-adapter comments.
 *
 * What the pins protect, beyond the text: `startsWith` is the ONLY operation
 * that moved. `contains`, `endsWith`, insensitive mode, a referenced-column
 * operand and an enum column all keep the `LEFT`/`substr` spelling, and each
 * of those is asserted here as a complement — a pattern operator appearing on
 * one of them would mean the routing condition in the where-builder had
 * widened past what the escaper can actually serve.
 *
 * The live answers behind these strings are in
 * {@link file://../drivers/like-escape-behavior.ts}, on all four drivers, and
 * the index-range claim itself is witnessed in
 * {@link file://./starts-with-prefix-plan.test.ts}.
 */

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `starts-with-prefix-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // SQL-only driver: nothing is allocated.
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

const Doc = s
  .model({
    id: s.string().id(),
    title: s.string(),
    slug: s.string().map("slug_col"),
    status: s.enum(["draft", "published"]),
    tags: s.string().array(),
  })
  .map("prefix_docs");

const schema = { Doc };

beforeAll(() => hydrateSchemaNames(schema));

const refs = createModelFieldRefs("Doc", Doc);

/** What the parse boundary says when a column may not carry a `startsWith`. */
const STARTS_WITH_REFUSAL =
  /Unknown key: startsWith|did not match any union member/;

/** The alias the engine gave `prefix_docs` in a built statement. */
const TABLE_ALIAS = /prefix_docs["`] AS (["`]\w+["`])/;

type DialectCase = {
  name: string;
  dialect: Dialect;
  createAdapter: () => DatabaseAdapter;
  /** The whole predicate for `title: { startsWith: value }`, default mode. */
  prefixPredicate: (column: string, value: string) => string;
  /** The bound values that predicate carries, in order. */
  prefixValues: (value: string) => unknown[];
  titleColumn: (alias: string) => string;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    createAdapter: () => new PostgresAdapter(),
    // Exact and index-usable in one predicate: PostgreSQL's LIKE is
    // case-sensitive natively.
    prefixPredicate: (column) => `${column} LIKE $1 ESCAPE '\\'`,
    prefixValues: (value) => [`${escapeLikeLiteral(value)}%`],
    titleColumn: (alias) => `${alias}."title"`,
  },
  {
    name: "MySQL",
    dialect: "mysql",
    createAdapter: () => new MySQLAdapter(),
    // Two conjuncts: the collation-native LIKE is the index accelerator, the
    // BINARY comparison is the case-sensitivity contract.
    prefixPredicate: (column) =>
      `(${column} LIKE $1 ESCAPE '\\\\' AND LEFT(BINARY ${column}, OCTET_LENGTH($2)) = BINARY $3)`,
    prefixValues: (value) => [`${escapeLikeLiteral(value)}%`, value, value],
    titleColumn: (alias) => `${alias}.\`title\``,
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    createAdapter: () => new SQLiteAdapter(),
    // GLOB, not LIKE: SQLite's LIKE optimization refuses an ESCAPE clause, and
    // LIKE would answer case-insensitively besides.
    prefixPredicate: (column) => `${column} GLOB $1`,
    prefixValues: (value) => [`${escapeGlobLiteral(value)}*`],
    titleColumn: (alias) => `${alias}."title"`,
  },
];

function buildDocQuery(
  dialectCase: DialectCase,
  args: Record<string, unknown>
) {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new QueryEngine(
    new MockDriver(dialectCase.createAdapter(), dialectCase.dialect),
    registry
  );
  const query = engine.build(Doc, "findMany", args);
  return { statement: query.toStatement("$n"), values: query.values };
}

/** The predicate text alone, with the table alias resolved. */
function predicateOf(
  dialectCase: DialectCase,
  args: Record<string, unknown>
): { predicate: string; values: unknown[]; alias: string } {
  const { statement, values } = buildDocQuery(dialectCase, args);
  const alias = statement.match(TABLE_ALIAS)?.[1] ?? "";
  return {
    predicate: statement.slice(statement.indexOf("WHERE") + "WHERE ".length),
    values,
    alias,
  };
}

describe.each(dialectCases)("$name startsWith SQL", (dialectCase) => {
  test("a plain-string startsWith emits the index-usable prefix predicate", () => {
    const { predicate, values, alias } = predicateOf(dialectCase, {
      where: { title: { startsWith: "abc" } },
    });

    expect(predicate).toBe(
      dialectCase.prefixPredicate(dialectCase.titleColumn(alias), "abc")
    );
    expect(values).toEqual(dialectCase.prefixValues("abc"));
  });

  test("the escape characters land in the bound pattern, not the SQL", () => {
    // The value is escaped client-side precisely so the pattern stays a single
    // bound constant — a pattern assembled in SQL from the operand would be
    // non-constant and lose the index range that motivated the change.
    const { predicate, values } = predicateOf(dialectCase, {
      where: { title: { startsWith: "a%b_c\\d" } },
    });

    expect(predicate).not.toContain("REPLACE");
    expect(predicate).not.toContain("a%b");
    expect(values).toEqual(dialectCase.prefixValues("a%b_c\\d"));
  });

  test("the empty value still produces a bare-wildcard pattern", () => {
    const { values } = predicateOf(dialectCase, {
      where: { title: { startsWith: "" } },
    });
    expect(values).toEqual(dialectCase.prefixValues(""));
  });

  test("endsWith keeps the LEFT/substr family — no dialect can range a suffix", () => {
    const { predicate } = predicateOf(dialectCase, {
      where: { title: { endsWith: "abc" } },
    });
    expect(predicate).not.toContain("LIKE");
    expect(predicate).not.toContain("GLOB");
  });

  test("contains keeps its own spelling", () => {
    const { predicate } = predicateOf(dialectCase, {
      where: { title: { contains: "abc" } },
    });
    expect(predicate).not.toContain("LIKE");
    expect(predicate).not.toContain("GLOB");
  });

  test("insensitive startsWith keeps the fold spelling", () => {
    // The fold wraps the COLUMN, so the range is gone either way; routing this
    // to the pattern operator would silently drop the fold and change answers.
    const { predicate, values } = predicateOf(dialectCase, {
      where: { title: { startsWith: "abc", mode: "insensitive" } },
    });
    expect(predicate).not.toContain("GLOB");
    expect(predicate).not.toContain("LIKE $1 ESCAPE");
    expect(values).toContain("abc");
  });

  test("a referenced-column operand keeps the LEFT/substr spelling", () => {
    // There is no client-side string to escape here, so the pattern operator
    // cannot serve this shape at all.
    const { predicate, values } = predicateOf(dialectCase, {
      where: { title: { startsWith: refs.slug } },
    });
    expect(predicate).not.toContain("GLOB");
    expect(predicate).not.toContain("ESCAPE");
    expect(predicate).toContain("slug_col");
    expect(values).toHaveLength(0);
  });

  // The where-builder routes a literal-string `startsWith` to the pattern
  // operator without re-checking the column's type, because the parse boundary
  // has already decided which columns may carry a `startsWith` at all. These
  // two pin that premise where it actually lives — if the boundary ever widened
  // to admit an enum, PostgreSQL would fail at `LIKE` on an enum-typed column
  // (its own type there, with no implicit text cast) and this is what would say
  // so first.
  test("the parse boundary refuses startsWith on an enum column", () => {
    expect(() =>
      predicateOf(dialectCase, { where: { status: { startsWith: "dra" } } })
    ).toThrow(STARTS_WITH_REFUSAL);
  });

  test("the parse boundary refuses startsWith on a string list", () => {
    expect(() =>
      predicateOf(dialectCase, { where: { tags: { startsWith: "ab" } } })
    ).toThrow(STARTS_WITH_REFUSAL);
  });
});

describe("the escapers", () => {
  test("escapeLikeLiteral quotes %, _ and the escape character itself", () => {
    expect(escapeLikeLiteral("50%")).toBe("50\\%");
    expect(escapeLikeLiteral("a_b")).toBe("a\\_b");
    expect(escapeLikeLiteral("x\\")).toBe("x\\\\");
    expect(escapeLikeLiteral("\\")).toBe("\\\\");
    expect(escapeLikeLiteral("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });

  test("escapeLikeLiteral leaves everything else alone", () => {
    expect(escapeLikeLiteral("")).toBe("");
    expect(escapeLikeLiteral("plain")).toBe("plain");
    // GLOB's metacharacters are not LIKE's.
    expect(escapeLikeLiteral("5*7?[x]")).toBe("5*7?[x]");
  });

  test("escapeGlobLiteral quotes *, ? and [ as one-character classes", () => {
    expect(escapeGlobLiteral("5*7")).toBe("5[*]7");
    expect(escapeGlobLiteral("why?")).toBe("why[?]");
    expect(escapeGlobLiteral("[draft]")).toBe("[[]draft]");
    expect(escapeGlobLiteral("*?[")).toBe("[*][?][[]");
  });

  test("escapeGlobLiteral leaves LIKE's metacharacters and backslash alone", () => {
    // GLOB has no ESCAPE clause and backslash means nothing to it, so quoting
    // a backslash here would make it match a literal backslash pair.
    expect(escapeGlobLiteral("a%b_c\\d")).toBe("a%b_c\\d");
    expect(escapeGlobLiteral("\\")).toBe("\\");
    expect(escapeGlobLiteral("")).toBe("");
    // A `]` outside a class is already literal in SQLite's GLOB.
    expect(escapeGlobLiteral("a]b")).toBe("a]b");
  });
});
