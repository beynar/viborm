import type { DatabaseAdapter } from "@adapters/database-adapter";
import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { type Dialect, Driver } from "@drivers";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { hydrateSchemaNames } from "@schema";
import { isSql } from "@sql";
import { createSchemaRegistry } from "@validation";
import { describe, expect, it } from "vitest";
import { sqlGenerationUserPostSchema } from "../fixtures/user-post-schema";

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

const expected = {
  postgresql: {
    read: {
      sql: 'SELECT "t0"."id" AS "id", "t0"."title" AS "title" FROM "posts" AS "t0" WHERE ("t0"."published" = $1 AND "t0"."views" >= $2) ORDER BY "t0"."views" DESC NULLS FIRST, "t0"."id" ASC NULLS LAST LIMIT $3',
      params: [true, 10, 5],
    },
    write: {
      sql: 'INSERT INTO "Author" ("id", "name", "email", "age", "metadata") VALUES ($1, $2, $3, $4, NULL) RETURNING "id" AS "id", "name" AS "name", "email" AS "email", "age" AS "age", "metadata" AS "metadata"',
      params: ["author-1", "Arnaud", "arnaud@example.com", 42],
    },
  },
  mysql: {
    read: {
      sql: "SELECT `t0`.`id` AS `id`, `t0`.`title` AS `title` FROM `posts` AS `t0` WHERE (`t0`.`published` = ? AND `t0`.`views` >= ?) ORDER BY (`t0`.`views` IS NULL) DESC, `t0`.`views` DESC, (`t0`.`id` IS NULL) ASC, `t0`.`id` ASC LIMIT 5",
      params: [true, 10],
    },
    write: {
      sql: "INSERT INTO `Author` (`id`, `name`, `email`, `age`, `metadata`) VALUES (?, ?, ?, ?, NULL)",
      params: ["author-1", "Arnaud", "arnaud@example.com", 42],
    },
  },
  sqlite: {
    read: {
      sql: 'SELECT "t0"."id" AS "id", "t0"."title" AS "title" FROM "posts" AS "t0" WHERE ("t0"."published" = ? AND "t0"."views" >= ?) ORDER BY ("t0"."views" IS NULL) DESC, "t0"."views" DESC, ("t0"."id" IS NULL) ASC, "t0"."id" ASC LIMIT ?',
      params: [true, 10, 5],
    },
    write: {
      sql: 'INSERT INTO "Author" ("id", "name", "email", "age", "metadata") VALUES (?, ?, ?, ?, NULL) RETURNING "id" AS "id", "name" AS "name", "email" AS "email", "age" AS "age", "metadata" AS "metadata"',
      params: ["author-1", "Arnaud", "arnaud@example.com", 42],
    },
  },
} as const;

describe("operation SQL and parameter equivalence oracles", () => {
  it.each(
    dialects
  )("freezes representative %s read and write SQL", (dialect, adapter, placeholder) => {
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
    const writeProgram = engine
      .prepare(schema.Author, "create", {
        data: {
          id: "author-1",
          name: "Arnaud",
          email: "arnaud@example.com",
          age: 42,
          metadata: null,
        },
      })
      .compile();
    const [writeStep] = writeProgram.steps;
    if (
      !writeStep ||
      writeStep.kind !== "write" ||
      !isSql(writeStep.statement)
    ) {
      throw new Error(
        "Expected create to begin with one concrete write statement."
      );
    }

    expect({
      read: { sql: read.toStatement(placeholder), params: read.values },
      write: {
        sql: writeStep.statement.toStatement(placeholder),
        params: writeStep.statement.values,
      },
    }).toEqual(expected[dialect]);
    expect(writeProgram.steps).toHaveLength(dialect === "mysql" ? 2 : 1);
  });
});
