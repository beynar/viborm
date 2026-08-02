import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames, s } from "@schema";
import { createSchemaRegistry } from "@validation";
import { beforeAll, describe, expect, test } from "vitest";

const ORDINARY_NULL_COMPARISON_REGEX = /[=<>]\s+NULL\b/i;
const CURSOR_ZERO_REGEX = /__viborm_cursor_0/g;
const CURSOR_ONE_REGEX = /__viborm_cursor_1/g;
const CURSOR_TWO_REGEX = /__viborm_cursor_2/g;
const CURSOR_ALIAS_DECLARATION_REGEX = /AS ["`]__viborm_cursor_\d+["`]/g;

class MockDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `cursor-sql-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient() {
    return null;
  }

  protected async closeClient() {
    // No external client is allocated by this SQL-only driver.
  }

  protected async execute<T>(
    _client: null,
    _statement: string,
    _params: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(
    _client: null,
    _statement: string,
    _params?: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    fn: (transaction: null) => Promise<T>
  ): Promise<T> {
    return fn(null);
  }
}

const User = s
  .model({
    alternate: s.string().unique(),
    id: s.string().id(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => Post),
  })
  .map("cursor_sql_users");

const Post = s
  .model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .manyToOne(() => User)
      .fields("userId")
      .references("id"),
  })
  .map("cursor_sql_posts");

const VectorItem = s
  .model({
    id: s.string().id(),
    embedding: s.vector().dimension(3),
  })
  .map("cursor_sql_vectors");

const schema = { User, Post, VectorItem };

type DialectCase = {
  name: string;
  dialect: Dialect;
  quote: '"' | "`";
  createAdapter: () => DatabaseAdapter;
};

const dialectCases: DialectCase[] = [
  {
    name: "PostgreSQL",
    dialect: "postgresql",
    quote: '"',
    createAdapter: () => new PostgresAdapter(),
  },
  {
    name: "MySQL",
    dialect: "mysql",
    quote: "`",
    createAdapter: () => new MySQLAdapter(),
  },
  {
    name: "SQLite",
    dialect: "sqlite",
    quote: '"',
    createAdapter: () => new SQLiteAdapter(),
  },
];

beforeAll(() => hydrateSchemaNames(schema));

describe.each(dialectCases)("$name cursor SQL", (dialectCase) => {
  test("one normalized order drives ORDER BY and one derived cursor row", () => {
    const query = buildUserQuery(dialectCase, {
      cursor: { alternate: "alternate-cursor" },
      orderBy: { age: { sort: "asc", nulls: "first" } },
      take: 2,
    });
    const orderClause = getOrderClause(query.statement);
    const ageIndex = orderClause.indexOf(quoted(dialectCase, "age"));
    const idIndex = orderClause.indexOf(quoted(dialectCase, "id"));
    const alternateIndex = orderClause.indexOf(
      quoted(dialectCase, "alternate")
    );

    expect(ageIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeGreaterThan(ageIndex);
    expect(alternateIndex).toBeGreaterThan(idIndex);
    expect(query.statement).toContain("IS NULL");
    expect(query.statement).toContain("IS NOT NULL");
    expect(query.statement).not.toMatch(ORDINARY_NULL_COMPARISON_REGEX);
    expect(
      query.values.filter((value) => value === "alternate-cursor")
    ).toHaveLength(1);
    expect(query.statement.match(CURSOR_ZERO_REGEX)).not.toBeNull();
    expect(query.statement.match(CURSOR_ONE_REGEX)).not.toBeNull();
    expect(query.statement.match(CURSOR_TWO_REGEX)).not.toBeNull();
    expect(countAliasDeclarations(query.statement)).toBe(3);
    expect(countTableReferences(query.statement, "cursor_sql_users")).toBe(2);
  });

  test("bare directions resolve portable null placement explicitly", () => {
    const ascending = buildUserQuery(dialectCase, {
      orderBy: { age: "asc" },
      take: 2,
    }).statement;
    const descending = buildUserQuery(dialectCase, {
      orderBy: { age: "desc" },
      take: 2,
    }).statement;

    expect(getOrderClause(ascending)).toContain(
      expectedOrder(dialectCase, "age", "asc", "last")
    );
    expect(getOrderClause(descending)).toContain(
      expectedOrder(dialectCase, "age", "desc", "first")
    );
  });

  test("negative take flips direction and null placement together", () => {
    const query = buildUserQuery(dialectCase, {
      cursor: { id: "cursor-id" },
      orderBy: { age: { sort: "asc", nulls: "first" } },
      skip: 1,
      take: -2,
    });
    const orderClause = getOrderClause(query.statement);

    expect(orderClause).toContain(
      expectedOrder(dialectCase, "age", "desc", "last")
    );
    // `id` is NOT NULL, so the flipped placement is unobservable and the key is
    // emitted bare — the tie-breaker no longer blocks the index.
    expect(orderClause).toContain(
      expectedNotNullOrder(dialectCase, "id", "desc")
    );
    const idColumn = `${quoted(dialectCase, "t0")}.${quoted(dialectCase, "id")}`;
    expect(orderClause).not.toContain(`(${idColumn} IS NULL)`);
    expect(orderClause).not.toContain(`${idColumn} DESC NULLS`);
    if (dialectCase.dialect === "mysql") {
      expect(query.statement).toContain("LIMIT 2");
      expect(query.statement).toContain("OFFSET 1");
    } else {
      expect(query.values).toContain(2);
      expect(query.values).toContain(1);
    }
    expect(query.values).not.toContain(-2);
  });

  test("include aliases remain distinct from the cursor derived row", () => {
    const query = buildUserQuery(dialectCase, {
      cursor: { id: "cursor-id" },
      orderBy: { age: "asc" },
      include: { posts: true },
      take: 2,
    });

    expect(query.statement).toContain("cursor_sql_posts");
    expect(query.statement).toContain("__viborm_cursor_0");
    expect(query.statement).toContain("__viborm_cursor_1");
  });

  test("count uses the normalized cursor order and derived row", () => {
    const engine = createEngine(dialectCase);
    const query = engine.build(User, "count", {
      cursor: { id: "cursor-id" },
      orderBy: { age: { sort: "asc", nulls: "last" } },
      skip: 1,
      take: 2,
    });
    const statement = query.toStatement("$n");

    expect(statement).toContain("__viborm_cursor_0");
    expect(statement).toContain("__viborm_cursor_1");
    expect(getOrderClause(statement)).toContain(
      expectedOrder(dialectCase, "age", "asc", "last")
    );
  });

  test("relation cursor ordering fails explicitly", () => {
    const engine = createEngine(dialectCase);

    expect(() =>
      engine.build(User, "findMany", {
        cursor: { id: "cursor-id" },
        orderBy: { posts: { _count: "asc" } },
        take: 2,
      })
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
  });

  test("vector-distance cursor ordering fails explicitly", () => {
    const engine = createEngine(dialectCase);

    expect(() =>
      engine.build(VectorItem, "findMany", {
        cursor: { id: "cursor-id" },
        orderBy: {
          embedding: {
            _distance: { to: [1, 2, 3], metric: "l2" },
          },
        },
        take: 2,
      })
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
  });
});

function createEngine(dialectCase: DialectCase): QueryEngine {
  const adapter = dialectCase.createAdapter();
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  return new QueryEngine(
    new MockDriver(adapter, dialectCase.dialect),
    registry
  );
}

function buildUserQuery(
  dialectCase: DialectCase,
  args: Record<string, unknown>
): { statement: string; values: unknown[] } {
  const query = createEngine(dialectCase).build(User, "findMany", args);
  return {
    statement: query.toStatement("$n"),
    values: query.values,
  };
}

function quoted(dialectCase: DialectCase, identifier: string): string {
  return `${dialectCase.quote}${identifier}${dialectCase.quote}`;
}

/**
 * The ORDER BY key a *nullable* column produces.
 *
 * PostgreSQL and SQLite both parse `NULLS FIRST/LAST` natively (SQLite since
 * 3.30, below the adapter's documented 3.35+ floor). MySQL has no native
 * syntax at any version and keeps the `(col IS NULL)` emulation.
 */
function expectedOrder(
  dialectCase: DialectCase,
  field: string,
  direction: "asc" | "desc",
  nulls: "first" | "last"
): string {
  const column = `${quoted(dialectCase, "t0")}.${quoted(dialectCase, field)}`;
  const keyword = direction.toUpperCase();
  if (dialectCase.dialect === "mysql") {
    const nullDirection = nulls === "first" ? "DESC" : "ASC";
    return `(${column} IS NULL) ${nullDirection}, ${column} ${keyword}`;
  }

  return `${column} ${keyword} NULLS ${nulls.toUpperCase()}`;
}

/**
 * The ORDER BY key a NOT NULL column produces: the bare direction, on every
 * dialect. There is no null placement to state, and stating one costs the
 * index — see `buildNormalizedOrderBy`.
 */
function expectedNotNullOrder(
  dialectCase: DialectCase,
  field: string,
  direction: "asc" | "desc"
): string {
  const column = `${quoted(dialectCase, "t0")}.${quoted(dialectCase, field)}`;
  return `${column} ${direction.toUpperCase()}`;
}

function getOrderClause(statement: string): string {
  const index = statement.lastIndexOf("ORDER BY");
  return index >= 0 ? statement.slice(index) : "";
}

function countAliasDeclarations(statement: string): number {
  return statement.match(CURSOR_ALIAS_DECLARATION_REGEX)?.length ?? 0;
}

function countTableReferences(statement: string, table: string): number {
  return statement.split(table).length - 1;
}
