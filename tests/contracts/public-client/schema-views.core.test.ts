/**
 * Schema views without a database (`docs/architecture/schema-views-plan.md`):
 * a view's body as the read compiler writes it for each dialect, the clauses
 * a view's query may not hold, a view's JSON column read as the plain column
 * it is, a write refused before any statement whoever makes it, and the
 * drivers that hold no view. Against databases:
 * `tests/contracts/public-client/schema-views-behavior.ts`.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import { createClient as createSnowflakeClient } from "@drivers/snowflake";
import { SurrealDriver } from "@drivers/surrealdb";
import {
  FeatureNotSupportedError,
  ForbiddenError,
  UnsupportedOperationError,
  ValidationError,
} from "@errors";
import { call } from "@extensions/call";
import { extension } from "@extensions/extension";
import { fields } from "@extensions/fields";
import { target, writes } from "@extensions/on";
import { viewBody } from "@query-engine/raptor3/view-body";
import { s } from "@schema";
import { type Sql, sql } from "@sql";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { ordering } from "@src/ordering";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import { v } from "@validation";
import { describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    big: s.bigInt(),
    posts: s.toMany(() => post),
  })
  .map("authors");
const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    views: s.bigInt(),
    score: s.decimal({ precision: 8, scale: 2 }),
    embedding: s.vector().dimension(2),
    published: s.boolean(),
    authorId: s.int().map("author_ref"),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => post)
      .name("thread")
      .fields("parentId")
      .references("id"),
    replies: s.toMany(() => post).name("thread"),
    deletedAt: s.dateTime().nullable(),
  })
  .map("posts");

const published = s
  .view(() => post, {
    where: { published: true },
    select: {
      id: true,
      views: true,
      score: true,
      authorId: true,
      author: { select: { name: true, big: true } },
      replies: { where: { views: { gt: 0n } }, take: 2, select: { id: true } },
    },
  })
  .map("published_posts");
const latest = s
  .view(() => post, {
    orderBy: { id: "desc" },
    take: 3,
    select: { id: true, title: true },
  })
  .map("latest_posts");
const popular = s
  .view(() => published, { select: { id: true, author: true } })
  .map("popular_posts");
const counted = s
  .view(() => author, { include: { _count: true } })
  .map("counted_authors");
/** No key of its source projected. */
const titles = s
  .view(() => post, { select: { title: true, deletedAt: true } })
  .map("post_titles");

const views = { published, latest, popular, counted, titles };
const schema = { author, post, ...views };

/** The adapter a migration of `dialect` writes a view's body with. */
const WRITERS = {
  postgresql: postgresMigrationDriver,
  mysql: mysqlMigrationDriver,
  sqlite: sqlite3MigrationDriver,
};
const writing = (dialect: keyof typeof WRITERS) =>
  WRITERS[dialect].viewWriter().adapter;

/** A declared query the body refuses, as the view that declares it. */
const refused = (query: object) => {
  const bad = s.view(() => post, query as never).map("bad_view");
  return () =>
    viewBody(
      { schema: { author, post, bad }, adapter: writing("postgresql") },
      bad
    );
};

const text = (statement: Sql) => statement.toStatement("$n");

const STORED_ROOT =
  /^SELECT "q0"\."id", "q0"\."views", "q0"\."score", "q0"\."author_ref", /;
const CARRIED_BIGINT =
  /json_build_array\("q\d+"\."name", CAST\("q\d+"\."big" AS TEXT\)\)/;
const ROOT_ORDER = /ORDER BY "q0"/;
const WINDOW_ORDER = /ORDER BY .q0.\..id. DESC LIMIT/;

describe("a view's body", () => {
  test("projects its root scalars as stored and its documents as a read carries them", () => {
    const body = viewBody(
      { schema, adapter: writing("postgresql") },
      published
    );
    const statement = text(body.statement);
    // A bigint and a decimal column as stored, under their column names.
    expect(statement).toMatch(STORED_ROOT);
    expect(statement).not.toContain('CAST("q0"');
    // Inside a document, a bigint travels as text, as a read carries it.
    expect(statement).toMatch(CARRIED_BIGINT);
    expect(statement).toContain('AS "author"');
    expect(statement).toContain('AS "replies"');
    // A view has no order: none at its root without a take.
    expect(statement).not.toMatch(ROOT_ORDER);
    expect(statement).toContain('"public"."posts" AS "q0"');
    expect(body.reads).toEqual(["posts", "authors"]);
  });

  test("keeps the root order of a window", () => {
    for (const dialect of ["postgresql", "mysql", "sqlite"] as const) {
      const statement = text(
        viewBody({ schema, adapter: writing(dialect) }, latest).statement
      );
      expect(statement).toMatch(WINDOW_ORDER);
    }
  });

  test("reads a source view's documents as its plain columns", () => {
    const body = viewBody({ schema, adapter: writing("sqlite") }, popular);
    expect(text(body.statement)).toBe(
      'SELECT "q0"."id" AS "id", "q0"."author" AS "author" FROM "published_posts" AS "q0"'
    );
    expect(body.reads).toEqual(["published_posts"]);
  });

  test("names its tables as the adapter it is written with names them", () => {
    const pg = viewBody(
      { schema, adapter: new PostgresAdapter("app", true) },
      published
    );
    expect(text(pg.statement)).toContain('"app"."posts" AS "q0"');
    expect(text(pg.statement)).toContain('"app"."authors"');
    const mysql = viewBody(
      { schema, adapter: new MySQLAdapter("shop") },
      counted
    );
    expect(text(mysql.statement)).toContain("`shop`.`authors` AS `q0`");
    expect(mysql.reads).toEqual(["authors", "posts"]);
  });

  test("states the shape a view row is decoded with, as JSON data", () => {
    const { shape } = viewBody(
      { schema, adapter: writing("sqlite") },
      published
    );
    expect(JSON.parse(JSON.stringify(shape))).toEqual(shape);
    expect(shape).toMatchObject({
      kind: "object",
      fields: {
        views: { kind: "scalar", type: "bigint", nullable: false },
        author: {
          kind: "object",
          fields: {
            name: { kind: "scalar", type: "string" },
            big: { kind: "scalar", type: "bigint" },
          },
        },
        replies: {
          kind: "collection",
          row: { kind: "object", fields: { id: { type: "int" } } },
        },
      },
    });
    expect(Object.keys((shape as { fields: object }).fields)).toEqual([
      "id",
      "views",
      "score",
      "authorId",
      "author",
      "replies",
    ]);
  });

  test("refuses each root clause a view cannot hold, naming the view", () => {
    expect(refused({ cursor: { id: 1 }, take: 2 })).toThrow(
      "View 'bad' cannot be created from a query that pages from a cursor"
    );
    expect(refused({ take: -2, orderBy: { id: "asc" } })).toThrow(
      "View 'bad' cannot be created from a query that takes a negative window"
    );
    expect(refused({ orderBy: { id: "asc" } })).toThrow(
      "View 'bad' cannot be created from a query that orders its rows without a take"
    );
    expect(refused({ skip: 1 })).toThrow(
      "View 'bad' cannot be created from a query that skips rows without a take"
    );
    expect(
      refused({
        take: 2,
        orderBy: { embedding: { _distance: { to: [1, 0], metric: "l2" } } },
      })
    ).toThrow(
      "View 'bad' cannot be created from a query that orders by a distance"
    );
    expect(
      refused({
        select: {
          id: true,
          embedding: { _distance: { to: [1, 0], metric: "l2" } },
        },
      })
    ).toThrow(
      "View 'bad' cannot be created from a query that selects a distance"
    );
    expect(refused({ where: { views: { gt: sql`1` } } })).toThrow(
      "View 'bad' cannot be created from a query that filters with an SQL fragment"
    );
    expect(
      refused({
        where: {
          views: {
            gt: ({ sql: fragment }: { sql: typeof sql }) => fragment`1`,
          },
        },
      })
    ).toThrow(UnsupportedOperationError);
    expect(
      refused({
        select: {
          id: true,
          replies: { recurse: { depth: 2 }, select: { id: true } },
        },
      })
    ).toThrow(
      "View 'bad' cannot be created from a query that reads a recursive relation or a polymorphic slot"
    );
  });

  test("keeps every clause inside a relation", () => {
    const relation = refused({
      select: {
        id: true,
        replies: {
          where: { views: { gt: 0n } },
          orderBy: { id: "desc" },
          skip: 1,
          take: 2,
          cursor: { id: 5 },
        },
      },
    });
    expect(relation).not.toThrow();
  });
});

/** A driver that answers nothing and records the text of what it is sent. */
class RecordingDriver extends SqlOnlyDriver {
  readonly sent: unknown[] = [];
  protected override async execute<T>(...statement: unknown[]) {
    this.sent.push(statement[1]);
    return { rows: [] as T[], rowCount: 0 };
  }
  protected override async executeRaw<T>(...statement: unknown[]) {
    this.sent.push(statement[1]);
    return { rows: [] as T[], rowCount: 0 };
  }
}

describe("a view at the client", () => {
  test("reads its JSON columns as the plain columns they are", () => {
    const client = createClient({
      schema,
      driver: new SqlOnlyDriver(new SQLiteAdapter(), "sqlite"),
    });
    expect(text(client.published.findMany().buildStatement()!)).toBe(
      'SELECT "q0"."id" AS "id", CAST("q0"."views" AS TEXT) AS "views", CAST("q0"."score" AS TEXT) AS "score", "q0"."author_ref" AS "authorId", "q0"."author" AS "author", "q0"."replies" AS "replies" FROM "published_posts" AS "q0" ORDER BY "q0"."id" ASC'
    );
    expect(
      text(
        client.published
          .findMany({ select: { id: true, author: true } })
          .buildStatement()!
      )
    ).toBe(
      'SELECT "q0"."id" AS "id", "q0"."author" AS "author" FROM "published_posts" AS "q0" ORDER BY "q0"."id" ASC'
    );
    expect(
      text(
        client.published
          .findMany({ omit: { author: true, replies: true } })
          .buildStatement()!
      )
    ).not.toContain('"author"');
  });

  test("takes a JSON column whole, and in no filter or order", async () => {
    const client = createClient({
      schema,
      driver: new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
    });
    await expect(
      client.published.findMany({
        // @ts-expect-error - a JSON column takes no nested arguments
        select: { id: true, author: { select: { name: true } } },
      })
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error - a JSON column is in no filter
      client.published.findMany({ where: { id: 1, author: null } })
    ).rejects.toThrow(ValidationError);
    await expect(
      // @ts-expect-error - nor in an order
      client.published.findMany({ orderBy: { author: "asc" } })
    ).rejects.toThrow(ValidationError);
  });

  test("refuses a write before any statement, whoever makes it", async () => {
    const driver = new RecordingDriver(new MySQLAdapter(), "mysql");
    const client = createClient({ schema, driver });
    const write = (on: typeof client): Promise<unknown> =>
      // @ts-expect-error - a view has no write
      on.published.create({ data: { id: 1 } });
    const refusal =
      "'published' is a view: it is read, never written (create).";
    await expect(write(client)).rejects.toThrow(refusal);
    await expect(write(client)).rejects.toThrow(UnsupportedOperationError);
    const chained = client.$extends(
      extension(
        "noop",
        call(() => undefined, target(writes))
      )
    );
    await expect(
      // @ts-expect-error - nor through a chain
      chained.published.deleteMany({})
    ).rejects.toThrow(
      "'published' is a view: it is read, never written (deleteMany)."
    );
    await expect(
      client.$transaction([
        client.post.findMany(),
        // @ts-expect-error - nor in a batch
        client.published.updateMany({ data: {} }),
      ])
    ).rejects.toThrow("never written (updateMany)");
    await expect(
      client.$transaction(async (tx) =>
        // @ts-expect-error - nor in a transaction
        tx.counted.upsert({ where: { id: 1 }, create: {}, update: {} })
      )
    ).rejects.toThrow("'counted' is a view");
    expect(driver.sent).toEqual([]);
    // What a read sends is recorded.
    await client.post.findMany();
    expect(driver.sent).toHaveLength(1);
  });

  test("refuses a unique read of a view without a key, naming it", async () => {
    const driver = new RecordingDriver(new PostgresAdapter(), "postgresql");
    const client = createClient({ schema, driver });
    const refusal =
      "'titles' is a view that projects no key of its source: no unique read names one of its rows (findUnique).";
    await expect(
      // @ts-expect-error - no key names one of its rows
      client.titles.findUnique({ where: { title: "t" } })
    ).rejects.toThrow(refusal);
    await expect(
      // @ts-expect-error - nor throws for one
      client.titles.findUniqueOrThrow({ where: { title: "t" } })
    ).rejects.toThrow(UnsupportedOperationError);
    await expect(
      client.$transaction(async (tx) =>
        // @ts-expect-error - nor in a transaction
        tx.titles.findUnique({ where: { title: "t" } })
      )
    ).rejects.toThrow(refusal);
    expect(driver.sent).toEqual([]);
    // A view that projects its source's key is read by it.
    await client.published.findUnique({ where: { id: 1 } });
    await client.titles.findFirst();
    expect(driver.sent).toHaveLength(2);
  });

  test("an extension that lists a view reads it, and adds it no method that writes", async () => {
    const driver = new RecordingDriver(new SQLiteAdapter(), "sqlite");
    const client = createClient({ schema, driver });
    const tombs = client.$extends(
      softDelete({ models: { titles: { deletedAt: "deletedAt" } } })
    );
    await tombs.titles.findMany();
    expect(driver.sent).toEqual([
      'SELECT "q0"."title" AS "title", "q0"."deletedAt" AS "deletedAt" FROM "post_titles" AS "q0" WHERE "q0"."deletedAt" IS NULL',
    ]);
    await expect(
      // @ts-expect-error - restore writes
      tombs.titles.restore({ where: { title: "t" } })
    ).rejects.toThrow(
      "'titles' is a view: it is read, never written (update)."
    );
    // Ordering moves a row by its key: it lists a view that projects one.
    const ranked = client.$extends(
      ordering({ models: { latest: { key: "title" } } })
    );
    await ranked.latest.findMany();
    expect(driver.sent.at(-1)).toContain(
      'ORDER BY "q0"."title" ASC, "q0"."id" ASC'
    );
    await expect(
      // @ts-expect-error - rekey writes
      ranked.latest.rekey()
    ).rejects.toThrow(
      "'latest' is a view: it is read, never written (updateMany)."
    );
  });

  test("switches its _count column off as any column, and computes from its columns", async () => {
    const driver = new RecordingDriver(new SQLiteAdapter(), "sqlite");
    const client = createClient({ schema, driver });
    await client.counted.findMany({ select: { name: true, _count: false } });
    expect(driver.sent).toEqual([
      'SELECT "q0"."name" AS "name" FROM "counted_authors" AS "q0" ORDER BY "q0"."id" ASC',
    ]);
    const computed = client.$extends(
      extension(
        "byline",
        fields({
          published: {
            byline: {
              needs: { author: true },
              compute: (row) => row.author.name,
            },
          },
        })
      )
    );
    await computed.published.findMany({ select: { id: true, byline: true } });
    expect(driver.sent.at(-1)).toContain('"q0"."author" AS "author"');
  });
});

/**
 * `$refresh` (plan §2.6): PostgreSQL's statement, sent as the client's raw
 * statement on the connection its delegate is bound to; nothing on a
 * database whose materialized view is an ordinary one. The refresh of a real
 * materialized view: `tests/providers/view-migrations-behavior.ts`.
 */
describe("a materialized view's $refresh", () => {
  const digest = s
    .view(() => author, { select: { id: true, name: true } })
    .materialized()
    .map("author_digest");
  /** Keyless: PostgreSQL has no unique index to match its rows by. */
  const headings = s
    .view(() => post, { select: { title: true } })
    .materialized()
    .map("headings");
  const stored = { author, post, published, digest, headings };

  /** A recording driver that also records where its transactions begin and end. */
  class BoundedDriver extends RecordingDriver {
    protected override async transaction<T>(
      _client: null,
      execute: (transaction: null) => Promise<T>
    ): Promise<T> {
      this.sent.push("BEGIN");
      const result = await execute(null);
      this.sent.push("COMMIT");
      return result;
    }
  }

  test("sends PostgreSQL's REFRESH, concurrent on request, to the view in the client's schema", async () => {
    const driver = new RecordingDriver(
      new PostgresAdapter("app"),
      "postgresql"
    );
    const client = createClient({ schema: stored, driver });
    await expect(client.digest.$refresh()).resolves.toBeUndefined();
    await client.digest.$refresh({ concurrently: true });
    await client.digest.$refresh({ concurrently: false });
    await client.headings.$refresh();
    expect(driver.sent).toEqual([
      'REFRESH MATERIALIZED VIEW "app"."author_digest"',
      'REFRESH MATERIALIZED VIEW CONCURRENTLY "app"."author_digest"',
      'REFRESH MATERIALIZED VIEW "app"."author_digest"',
      'REFRESH MATERIALIZED VIEW "app"."headings"',
    ]);
  });

  test.each([
    ["SQLite", new SQLiteAdapter(), "sqlite"],
    ["MySQL", new MySQLAdapter(), "mysql"],
  ] as const)("sends nothing on %s, where a materialized view is an ordinary one", async (_, adapter, dialect) => {
    const driver = new RecordingDriver(adapter, dialect);
    const client = createClient({ schema: stored, driver });
    await expect(client.digest.$refresh()).resolves.toBeUndefined();
    await expect(
      client.digest.$refresh({ concurrently: true })
    ).resolves.toBeUndefined();
    expect(driver.sent).toEqual([]);
  });

  test("refuses a model that is not a materialized view, and a concurrent refresh without a key, on every database", async () => {
    for (const driver of [
      new RecordingDriver(new PostgresAdapter(), "postgresql"),
      new RecordingDriver(new SQLiteAdapter(), "sqlite"),
    ]) {
      const client = createClient({ schema: stored, driver });
      // What a JavaScript caller, or a cast, reaches.
      const loose = client as unknown as Record<
        "published" | "post",
        { $refresh(): Promise<void> }
      >;
      await expect(loose.published.$refresh()).rejects.toThrow(
        "'published' is not a materialized view ($refresh)."
      );
      await expect(loose.post.$refresh()).rejects.toThrow(
        UnsupportedOperationError
      );
      await expect(
        client.headings.$refresh({ concurrently: true })
      ).rejects.toThrow(
        "'headings' has no key to be refreshed concurrently by ($refresh)."
      );
      expect(driver.sent).toEqual([]);
    }
  });

  test("runs on the connection of the delegate it is called on: in a transaction, in it", async () => {
    const driver = new BoundedDriver(new PostgresAdapter(), "postgresql");
    const client = createClient({ schema: stored, driver });
    await client.$transaction(async (tx) => {
      await tx.digest.$refresh();
    });
    expect(driver.sent).toEqual([
      "BEGIN",
      'REFRESH MATERIALIZED VIEW "public"."author_digest"',
      "COMMIT",
    ]);
  });

  test("is sent once, when first awaited: the array form of $transaction refuses it with nothing sent", async () => {
    const driver = new BoundedDriver(new PostgresAdapter(), "postgresql");
    const client = createClient({ schema: stored, driver });
    const pending = client.digest.$refresh();
    expect(driver.sent).toEqual([]);
    await expect(
      client.$transaction([client.author.count(), pending as never] as never)
    ).rejects.toThrow(
      "$transaction array must contain only pending operations"
    );
    expect(driver.sent).toEqual([]);
    await pending;
    await pending;
    expect(driver.sent).toEqual([
      'REFRESH MATERIALIZED VIEW "public"."author_digest"',
    ]);
  });

  test("is a raw statement to an extension chain: seen as one, and governed by no policy", async () => {
    const driver = new RecordingDriver(new PostgresAdapter(), "postgresql");
    const seen: string[] = [];
    const client = createClient({ schema: stored, driver }).$extends(
      extension(
        "seen",
        call((c) => {
          seen.push(c.operation);
        })
      )
    );
    await client.digest.$refresh();
    expect(seen).toEqual(["$executeRaw"]);
    // A policy governs model calls: a view it does not list is not read,
    // and is refreshed as a raw statement runs.
    const governed = createClient({ schema: stored, driver })
      .$extends(
        permissions({
          actor: v.object({ userId: v.string() }),
          models: { post: { read: {} } },
        } as never)
      )
      .$as({ userId: "u" } as never);
    await expect(governed.digest.findMany()).rejects.toThrow(ForbiddenError);
    await governed.digest.$refresh();
    expect(driver.sent).toEqual([
      'REFRESH MATERIALIZED VIEW "public"."author_digest"',
      'REFRESH MATERIALIZED VIEW "public"."author_digest"',
    ]);
  });
});

describe("the drivers that hold a view, and the one that does not", () => {
  test("SurrealDB holds one: a schema with views makes its client", () => {
    expect(() =>
      createClient({
        schema,
        driver: new SurrealDriver({ client: {} as never }),
      })
    ).not.toThrow();
  });

  test("Snowflake refuses a schema holding one as the client is created", () => {
    const create = () =>
      createSnowflakeClient({
        schema,
        account: "myorg-acct",
        token: "oauth-token",
        warehouse: "WH",
        database: "DB",
        namespace: "PUBLIC",
        fetch: async () => Response.json({}),
      });
    expect(create).toThrow(FeatureNotSupportedError);
    expect(create).toThrow(
      "snowflake.view is not supported. The schema declares 'published' as a view"
    );
  });
});
