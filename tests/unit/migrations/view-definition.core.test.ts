/**
 * A declared view's definition (`viewDefinition`), from `s.view` to the
 * snapshot, without a database: the body written without parameters, what it
 * reads, and the identity. The identity is the declared query, its source,
 * the decoder shape and the relations of the tables read; these pin what
 * changes it and what does not. What a change to a table a view reads does is
 * the program's (`views.core.test.ts`).
 */

import { s } from "@schema";
import { JsonNull } from "@schema/json-null";
import type { AnyModel, Model } from "@schema/model";
import { diff } from "@src/migrations/differ";
import type { MigrationDriver } from "@src/migrations/drivers/base";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { surrealMigrationDriver } from "@src/migrations/drivers/surrealql";
import { serializeModels } from "@src/migrations/serializer";
import { prepareSchemaProgram } from "@src/migrations/utils";
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
    /** A model that reaches `post` through a polymorphic slot. */
    commented?: boolean;
  } = {}
): Record<string, AnyModel> & { user: AnyModel; post: AnyModel } {
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
  const comment: AnyModel = model({
    id: s.string().id(),
    commentable: s.toOne({ post: () => post }),
  }).map("comments");
  const tables: Record<string, AnyModel> = { user, post, tag };
  if (extra.liked) tables.like = like;
  if (extra.commented) tables.comment = comment;
  return { ...tables, user, post };
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
  const schema: Record<string, AnyModel> = { ...tables, ...declare(tables) };
  return serializeModels(schema, { migrationDriver });
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

  it("follows a relation crossed behind a polymorphic slot", () => {
    const behind = (traded: boolean) =>
      serialized(
        (tables) => ({
          noted: view(() => tables.comment!, {
            where: {
              commentable: {
                type: "post",
                is: { author: { name: "Ann" } },
              },
            },
            select: { id: true },
          }).map("noted"),
        }),
        sqlite3MigrationDriver,
        { commented: true, traded }
      ).views![0]!;
    expect(behind(false).dependsOn).toEqual(["comments", "posts", "users"]);
    expect(behind(true).hash).not.toBe(behind(false).hash);
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

describe("a view's identity reads its query without loss", () => {
  const noted = (query: object, migrationDriver = sqlite3MigrationDriver) =>
    serialized(
      ({ post }) => ({ feed: view(() => post, query).map("feed") }),
      migrationDriver,
      { post: { meta: s.json().nullable(), likes: s.int(), stars: s.int() } }
    );
  const hashOf = (query: object) => noted(query).views![0]!.hash;
  const metaIs = (operand: unknown) => ({
    where: { meta: { equals: operand } },
    select: { id: true },
  });
  /** How many bodies and how many identities the queries have: as many as there are queries. */
  const kinds = (queries: object[]) => ({
    bodies: new Set(queries.map((query) => noted(query).views![0]!.sql)).size,
    hashes: new Set(queries.map(hashOf)).size,
  });
  const each = (count: number) => ({ bodies: count, hashes: count });

  it("a value JSON has no spelling for is never the object that would spell it", () => {
    const at = new Date("2026-01-01T00:00:00.000Z");
    expect(
      kinds([
        metaIs(JsonNull),
        metaIs({ $jsonNull: "JsonNull" }),
        metaIs({ $raw: { $jsonNull: "JsonNull" } }),
        metaIs({ $date: String(at.getTime()) }),
        metaIs({ $bigint: "5" }),
        metaIs({ $field: "likes" }),
      ])
    ).toEqual(each(6));
    expect(hashOf({ where: { at }, select: { id: true } })).not.toBe(
      hashOf({
        where: { at: new Date("2026-01-02T00:00:00.000Z") },
        select: { id: true },
      })
    );
  });

  it("a JSON operand is read whole, a member named `~` included", () => {
    expect(
      kinds([metaIs({ "~": 1 }), metaIs({ "~": 2 }), metaIs({ "~": { a: 1 } })])
    ).toEqual(each(3));
  });

  it("a callback is the column it answers", () => {
    type Ask = { fields: Record<string, unknown> };
    const likesOver = (operand: unknown) => ({
      where: { likes: { gt: operand } },
      select: { id: true },
    });
    expect(
      kinds([
        likesOver((ask: Ask) => ask.fields.likes),
        likesOver((ask: Ask) => ask.fields.stars),
        likesOver(6),
      ])
    ).toEqual(each(3));
  });

  it("a query changed in a value alone plans the view's replacement", async () => {
    const pairs: [object, object][] = [
      [metaIs(JsonNull), metaIs({ $jsonNull: "JsonNull" })],
      [metaIs({ "~": 1 }), metaIs({ "~": 2 })],
    ];
    for (const [before, after] of pairs) {
      const { operations } = await diff(noted(before), noted(after));
      expect(operations.map(({ type }) => type)).toEqual([
        "dropView",
        "createView",
      ]);
    }
  });
});

describe("a primary key change under a view", () => {
  // The key is the order a body breaks ties by: which rows a `take` keeps.
  const keyed = (slugIsKey: boolean, migrationDriver: MigrationDriver) => {
    const post: AnyModel = model({
      id: slugIsKey ? s.string().unique() : s.string().id(),
      slug: slugIsKey ? s.string().id() : s.string().unique(),
      title: s.string(),
    }).map("posts");
    const schema: Record<string, AnyModel> = {
      post,
      feed: view(() => post, { take: 2, select: { title: true } }).map("feed"),
    };
    return serializeModels(schema, { migrationDriver });
  };

  it.each([
    ["PostgreSQL", postgresMigrationDriver],
    ["MySQL", mysqlMigrationDriver],
    ["SQLite", sqlite3MigrationDriver],
  ] as const)("%s: the view keeps its hash, its body changes, and the program replaces it", async (_, migrationDriver) => {
    const from = keyed(false, migrationDriver);
    const to = keyed(true, migrationDriver);
    expect(to.views![0]!.hash).toBe(from.views![0]!.hash);
    expect(to.views![0]!.sql).not.toBe(from.views![0]!.sql);
    const { operations } = await diff(from, to);
    const program = prepareSchemaProgram(
      operations,
      from,
      to,
      migrationDriver
    ).map(({ type }) => type);
    expect(program.at(0)).toBe("dropView");
    expect(program.at(-1)).toBe("createView");
    expect(program).toContain("addPrimaryKey");
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
