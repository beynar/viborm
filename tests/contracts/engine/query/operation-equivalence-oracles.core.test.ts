import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it } from "vitest";
import { sqlGenerationUserPostSchema } from "@tests/fixtures/user-post-schema";

class OracleDriver extends Driver<null, null> {
  readonly adapter: DatabaseAdapter;

  constructor(adapter: DatabaseAdapter, dialect: Dialect) {
    super(dialect, `oracle-${dialect}`);
    this.adapter = adapter;
  }

  protected async initClient(): Promise<null> {
    return null;
  }

  protected async closeClient(): Promise<void> {
    // The oracle never opens a provider connection.
  }

  protected async execute<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async executeRaw<T>(): Promise<{ rows: T[]; rowCount: number }> {
    return { rows: [], rowCount: 0 };
  }

  protected async transaction<T>(
    _client: null,
    execute: (transaction: null) => Promise<T>
  ): Promise<T> {
    return execute(null);
  }
}

const schema = sqlGenerationUserPostSchema;
hydrateSchemaNames(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));

const dialects = [
  ["postgresql", new PostgresAdapter(), "$n"],
  ["mysql", new MySQLAdapter(), "?"],
  ["sqlite", new SQLiteAdapter(), "?"],
] as const;

// Deliberate re-freeze, query-performance plan Phase 5 Unit 5.1: `views` and
// `id` are both NOT NULL in this fixture, so no null placement is observable
// on either key and none is emitted. Every dialect loses its placement here —
// PostgreSQL its `NULLS FIRST/LAST` suffix, MySQL and SQLite their leading
// `(col IS NULL)` sort key, which is what let the index supply the order.
const expected = {
  postgresql: {
    read: {
      sql: 'SELECT "t0"."id" AS "id", "t0"."title" AS "title" FROM "public"."posts" AS "t0" WHERE ("t0"."published" = $1 AND "t0"."views" >= $2) ORDER BY "t0"."views" DESC, "t0"."id" ASC LIMIT $3',
      params: [true, 10, 5],
    },
  },
  mysql: {
    read: {
      sql: "SELECT `t0`.`id` AS `id`, `t0`.`title` AS `title` FROM `posts` AS `t0` WHERE (`t0`.`published` = ? AND `t0`.`views` >= ?) ORDER BY `t0`.`views` DESC, `t0`.`id` ASC LIMIT 5",
      params: [true, 10],
    },
  },
  sqlite: {
    read: {
      sql: 'SELECT "t0"."id" AS "id", "t0"."title" AS "title" FROM "posts" AS "t0" WHERE ("t0"."published" = ? AND "t0"."views" >= ?) ORDER BY "t0"."views" DESC, "t0"."id" ASC LIMIT ?',
      params: [true, 10, 5],
    },
  },
} as const;

describe("operation SQL and parameter equivalence oracles", () => {
  it.each(
    dialects
  )("freezes representative %s read SQL", (dialect, adapter, placeholder) => {
    const engine = new QueryEngine(
      new OracleDriver(adapter, dialect),
      registry
    );
    const read = engine.build(schema.Post, "findMany", {
      select: { id: true, title: true },
      where: { published: true, views: { gte: 10 } },
      orderBy: { views: "desc" },
      take: 5,
    });

    expect({
      read: { sql: read.toStatement(placeholder), params: read.values },
    }).toEqual(expected[dialect]);
  });
});
