/**
 * A declared view's definition (`viewDefinition`), from `s.view` to the
 * snapshot, without a database: the body written without parameters, what it
 * reads, and the identity. The identity is the declared query, its source,
 * the decoder shape and the relations of the tables read; these pin what
 * changes it and what does not. What a change to a table a view reads does is
 * the program's (`views.core.test.ts`).
 */

import { s } from "@schema";
import type { AnyModel, Model } from "@schema/model";
import type { MigrationDriver } from "@src/migrations/drivers/base";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { surrealMigrationDriver } from "@src/migrations/drivers/surrealql";
import { serializeModels } from "@src/migrations/serializer";
import { describe, expect, it } from "vitest";

const VIEW_HASH = /^[0-9a-f]{40}$/;
const AUTHOR_COLUMN = / AS "author"/;
const PLACEHOLDER = /\?|\$\d/;

// These pin run-time identity over schemas built with and without a member,
// so the builders are taken untyped: a model's type is not what is tested.
type Fields = Record<string, unknown>;
const model = s.model as unknown as (shape: Fields) => Model<any>;
const view = s.view as unknown as (
  source: () => AnyModel,
  query: object
) => AnyModel;

/** A fresh schema each time: a model object binds one schema key for good. */
function models(
  extra: {
    user?: Fields;
    post?: Fields;
    traded?: boolean;
    /** A model and a relation of `user` that no view of these tests crosses. */
    liked?: boolean;
  } = {}
) {
  const [authorColumn, editorColumn] = extra.traded
    ? ["editorId", "authorId"]
    : ["authorId", "editorId"];
  const user: AnyModel = model({
    id: s.string().id(),
    name: s.string(),
    posts: s.toMany(() => post),
    edited: s.toMany(() => post).name("editor"),
    tags: s.toMany(() => tag),
    ...(extra.liked ? { likes: s.toMany(() => like) } : {}),
    ...extra.user,
  }).map("users");
  const like: AnyModel = model({
    id: s.string().id(),
    userId: s.string(),
    user: s
      .toOne(() => user)
      .fields("userId")
      .references("id"),
  }).map("likes");
  const post: AnyModel = model({
    id: s.string().id(),
    title: s.string(),
    views: s.bigInt(),
    published: s.boolean(),
    at: s.dateTime(),
    authorId: s.string(),
    editorId: s.string(),
    author: s
      .toOne(() => user)
      .fields(authorColumn!)
      .references("id"),
    editor: s
      .toOne(() => user)
      .name("editor")
      .fields(editorColumn!)
      .references("id"),
    ...extra.post,
  }).map("posts");
  const tag: AnyModel = model({
    id: s.string().id(),
    users: s.toMany(() => user),
  }).map("tags");
  return extra.liked ? { user, post, tag, like } : { user, post, tag };
}

const QUERY = {
  where: { published: true },
  select: { id: true, title: true, author: { select: { name: true } } },
} as const;

function serialized(
  declare: (tables: ReturnType<typeof models>) => Record<string, AnyModel>,
  migrationDriver: MigrationDriver = sqlite3MigrationDriver,
  extra?: Parameters<typeof models>[0]
) {
  const tables = models(extra);
  return serializeModels(
    { ...tables, ...declare(tables) },
    { migrationDriver }
  );
}

const feed = (query: object = QUERY) =>
  serialized(({ post }) => ({
    feed: view(() => post, query).map("feed"),
  })).views![0]!;

describe("a declared view in a snapshot", () => {
  it("is a definition, never a table: its body, its identity and what it reads", () => {
    const snapshot = serialized(({ post }) => ({
      feed: view(() => post, QUERY).map("feed"),
    }));
    expect(snapshot.tables.map(({ name }) => name).sort()).toEqual([
      "posts",
      "tag_user",
      "tags",
      "users",
    ]);
    const [stored] = snapshot.views!;
    expect(stored).toMatchObject({
      name: "feed",
      dependsOn: ["posts", "users"],
    });
    expect(stored!.hash).toMatch(VIEW_HASH);
    // Root scalars as stored, the relation as one JSON column, no parameter.
    expect(stored!.sql).toContain('"published" = 1.0');
    expect(stored!.sql).toMatch(AUTHOR_COLUMN);
    expect(stored!.sql).not.toMatch(PLACEHOLDER);
  });

  it("a schema without a view has no views key", () => {
    expect(serialized(() => ({}))).not.toHaveProperty("views");
  });

  it("reads the junction table of a relation it crosses, and the view it reads", () => {
    const snapshot = serialized(({ user, post }) => {
      const tagged = s
        .view(() => user, { where: { tags: { some: {} } } })
        .map("tagged");
      return {
        tagged,
        named: view(() => tagged, { select: { name: true } }).map("named"),
        feed: view(() => post, QUERY).map("feed"),
      };
    });
    expect(
      Object.fromEntries(
        snapshot.views!.map(({ name, dependsOn }) => [name, dependsOn])
      )
    ).toEqual({
      feed: ["posts", "users"],
      named: ["tagged"],
      tagged: ["tag_user", "tags", "users"],
    });
  });

  it("names its tables by the estate's schema on PostgreSQL, and by no database on MySQL", () => {
    const declare = ({ post }: ReturnType<typeof models>) => ({
      feed: view(() => post, QUERY).map("feed"),
    });
    expect(
      serialized(declare, postgresMigrationDriver).views![0]!.sql
    ).toContain('"public"."posts"');
    const mysql = serialized(declare, mysqlMigrationDriver).views![0]!.sql;
    expect(mysql).toContain("`posts`");
    expect(mysql).not.toContain(".`posts`");
  });

  it("is refused where VibORM creates no view", () => {
    expect(() =>
      serialized(
        ({ post }) => ({ feed: view(() => post, QUERY) }),
        surrealMigrationDriver
      )
    ).toThrow("views arrive there with materialized views");
  });
});

describe("a view's identity", () => {
  it("is the same for the same declaration", () => {
    expect(feed().hash).toBe(feed().hash);
  });

  it("changes with the declared query, a value's kind included", () => {
    const hashes = [
      QUERY,
      { ...QUERY, where: { published: false } },
      { ...QUERY, where: { views: 5n } },
      { ...QUERY, where: { views: 6n } },
      { ...QUERY, where: { at: new Date("2026-01-01T00:00:00.000Z") } },
      { ...QUERY, where: { at: new Date("2026-01-02T00:00:00.000Z") } },
      { ...QUERY, select: { id: true, title: true } },
    ].map((query) => feed(query).hash);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  it("changes when a document gains a member: a client would decode another shape", () => {
    const declare = ({ post }: ReturnType<typeof models>) => ({
      feed: s
        .view(() => post, { select: { id: true, author: true } })
        .map("feed"),
    });
    const before = serialized(declare).views![0]!;
    const after = serialized(declare, sqlite3MigrationDriver, {
      user: { bio: s.string().nullable() },
    }).views![0]!;
    expect(after.hash).not.toBe(before.hash);
  });

  it("keeps its hash when its source gains a column it does not project", () => {
    const declare = ({ post }: ReturnType<typeof models>) => ({
      feed: view(() => post, QUERY).map("feed"),
    });
    const after = serialized(declare, sqlite3MigrationDriver, {
      post: { subtitle: s.string().nullable() },
    }).views![0]!;
    expect(after.hash).toBe(feed().hash);
  });

  it("keeps its hash when a model it reads gains a relation its query does not cross", () => {
    const declare = ({ post }: ReturnType<typeof models>) => ({
      feed: view(() => post, QUERY).map("feed"),
    });
    const after = serialized(declare, sqlite3MigrationDriver, {
      liked: true,
    }).views![0]!;
    expect(after.hash).toBe(feed().hash);
    expect(after.sql).toBe(feed().sql);
  });

  it("changes when a relation it reads moves to another column that was already there", () => {
    // The two relations trade their columns: the same columns and foreign
    // keys, another row behind `author`.
    const moved = serialized(
      ({ post }) => ({ feed: view(() => post, QUERY).map("feed") }),
      sqlite3MigrationDriver,
      { traded: true }
    ).views![0]!;
    expect(moved.hash).not.toBe(feed().hash);
    expect(moved.sql).not.toBe(feed().sql);
  });
});

const GOLDEN = {
  postgresql:
    'SELECT "q0"."id", "q0"."views", "q3"."r" AS "author", json_build_array((SELECT COUNT(*) FROM "public"."users" AS "q4" WHERE "q0"."authorId" = "q4"."id")) AS "_count" FROM "public"."posts" AS "q0" LEFT JOIN LATERAL (SELECT json_build_array("q2"."name") AS "r" FROM (SELECT "q1"."name" FROM "public"."users" AS "q1" WHERE "q0"."authorId" = "q1"."id" LIMIT \'1\') AS "q2") AS "q3" ON TRUE WHERE ("q0"."published" = \'true\' AND "q0"."title" LIKE \'%it\'\'s%\' ESCAPE \'\\\')',
  mysql:
    "SELECT `q0`.`id`, `q0`.`views`, (SELECT JSON_ARRAY(`q2`.`name`) FROM (SELECT `q1`.`name` FROM `users` AS `q1` WHERE `q0`.`authorId` = `q1`.`id` LIMIT 1) AS `q2`) AS `author`, JSON_ARRAY((SELECT COUNT(*) FROM `users` AS `q3` WHERE `q0`.`authorId` = `q3`.`id`)) AS `_count` FROM `posts` AS `q0` WHERE (`q0`.`published` = TRUE AND LOCATE(BINARY 'it''s', BINARY BINARY `q0`.`title`) > 0)",
  sqlite:
    'SELECT "q0"."id" AS "id", "q0"."views" AS "views", (SELECT json_array("q2"."name") FROM (SELECT "q1"."name" AS "name" FROM "users" AS "q1" WHERE "q0"."authorId" = "q1"."id" LIMIT 1.0) AS "q2") AS "author", json_array((SELECT COUNT(*) FROM "users" AS "q3" WHERE "q0"."authorId" = "q3"."id")) AS "_count" FROM "posts" AS "q0" WHERE ("q0"."published" = 1.0 AND instr("q0"."title" COLLATE BINARY, \'it\'\'s\') > 0)',
};

/**
 * The body each dialect writes for one view, as text. The text is not a
 * view's identity, so a change here plans no migration by itself: this test
 * is where that is decided. If the engine only respells the read (the rows
 * and the documents a client decodes are the same), update the text. If a
 * JSON column would hold a document in another encoding while the decoder
 * shape stays the same, raise `VIEW_REVISION` (`view-definition.ts`) so that
 * every view is written again, then update the text.
 */
describe("the body of a view, VIEW_REVISION 1", () => {
  const GOLDEN_QUERY = {
    where: { published: true, title: { contains: "it's" } },
    select: {
      id: true,
      views: true,
      author: { select: { name: true } },
      _count: { select: { author: true } },
    },
  };
  const body = (migrationDriver: MigrationDriver) =>
    serialized(
      ({ post }) => ({ feed: view(() => post, GOLDEN_QUERY).map("feed") }),
      migrationDriver
    ).views![0]!.sql;
  it.each([
    ["PostgreSQL", postgresMigrationDriver, GOLDEN.postgresql],
    ["MySQL", mysqlMigrationDriver, GOLDEN.mysql],
    ["SQLite", sqlite3MigrationDriver, GOLDEN.sqlite],
  ] as const)("%s", (_, migrationDriver, expected) => {
    expect(body(migrationDriver)).toBe(expected);
  });
});
