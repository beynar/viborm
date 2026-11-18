/**
 * A declared view's definition (`viewDefinition`), from `s.view` to the
 * snapshot, without a database: the body written without parameters, what it
 * reads, and the identity. The identity is the declared query, its source,
 * the decoder shape and the relations of the tables read; these pin what
 * changes it and what does not. What a change to a table a view reads does is
 * the program's (`views.core.test.ts`).
 */

import { s } from "@schema";
import { mysqlMigrationDriver } from "@src/migrations/drivers/mysql";
import { postgresMigrationDriver } from "@src/migrations/drivers/postgres";
import { sqlite3MigrationDriver } from "@src/migrations/drivers/sqlite";
import { surrealMigrationDriver } from "@src/migrations/drivers/surrealql";
import { serializeModels } from "@src/migrations/serializer";
import { describe, expect, it } from "vitest";

const VIEW_HASH = /^[0-9a-f]{40}$/;
const AUTHOR_COLUMN = / AS "author"/;
const PLACEHOLDER = /\?|\$\d/;

type Fields = Parameters<typeof s.model>[0];

/** A fresh schema each time: a model object binds one schema key for good. */
function models(extra: { user?: Fields; post?: Fields } = {}) {
  const user = s
    .model({
      id: s.string().id(),
      name: s.string(),
      posts: s.toMany(() => post),
      edited: s.toMany(() => post).name("editor"),
      tags: s.toMany(() => tag),
      ...extra.user,
    })
    .map("users");
  const post = s
    .model({
      id: s.string().id(),
      title: s.string(),
      views: s.bigInt(),
      published: s.boolean(),
      at: s.dateTime(),
      authorId: s.string(),
      editorId: s.string(),
      author: s
        .toOne(() => user)
        .fields("authorId")
        .references("id"),
      editor: s
        .toOne(() => user)
        .name("editor")
        .fields("editorId")
        .references("id"),
      ...extra.post,
    })
    .map("posts");
  const tag = s
    .model({ id: s.string().id(), users: s.toMany(() => user) })
    .map("tags");
  return { user, post, tag };
}

const QUERY = {
  where: { published: true },
  select: { id: true, title: true, author: { select: { name: true } } },
} as const;

function serialized(
  declare: (tables: ReturnType<typeof models>) => Record<string, unknown>,
  migrationDriver = sqlite3MigrationDriver,
  extra?: Parameters<typeof models>[0]
) {
  const tables = models(extra);
  return serializeModels({ ...tables, ...declare(tables) } as never, {
    migrationDriver,
  });
}

const feed = (query: object = QUERY) =>
  serialized(({ post }) => ({
    feed: s.view(() => post, query as never).map("feed"),
  })).views![0]!;

describe("a declared view in a snapshot", () => {
  it("is a definition, never a table: its body, its identity and what it reads", () => {
    const snapshot = serialized(({ post }) => ({
      feed: s.view(() => post, QUERY).map("feed"),
    }));
    expect(snapshot.tables.map(({ name }) => name).sort()).toEqual([
      "posts",
      "tag_user",
      "tags",
      "users",
    ]);
    const [view] = snapshot.views!;
    expect(view).toMatchObject({ name: "feed", dependsOn: ["posts", "users"] });
    expect(view!.hash).toMatch(VIEW_HASH);
    // Root scalars as stored, the relation as one JSON column, no parameter.
    expect(view!.sql).toContain('"published" = 1.0');
    expect(view!.sql).toMatch(AUTHOR_COLUMN);
    expect(view!.sql).not.toMatch(PLACEHOLDER);
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
        named: s.view(() => tagged, { select: { name: true } }).map("named"),
        feed: s.view(() => post, QUERY).map("feed"),
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
      feed: s.view(() => post, QUERY).map("feed"),
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
        ({ post }) => ({ feed: s.view(() => post, QUERY) }),
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
      feed: s.view(() => post, QUERY).map("feed"),
    });
    const after = serialized(declare, sqlite3MigrationDriver, {
      post: { subtitle: s.string().nullable() },
    }).views![0]!;
    expect(after.hash).toBe(feed().hash);
  });

  it("changes when a relation it reads moves to another column that was already there", () => {
    const moved = (() => {
      const user = s
        .model({
          id: s.string().id(),
          name: s.string(),
          posts: s.toMany(() => post),
          edited: s.toMany(() => post).name("editor"),
          tags: s.toMany(() => tag),
        })
        .map("users");
      const post = s
        .model({
          id: s.string().id(),
          title: s.string(),
          views: s.bigInt(),
          published: s.boolean(),
          at: s.dateTime(),
          authorId: s.string(),
          editorId: s.string(),
          // The two relations trade their columns: the same columns and
          // foreign keys, another row behind `author`.
          author: s
            .toOne(() => user)
            .fields("editorId")
            .references("id"),
          editor: s
            .toOne(() => user)
            .name("editor")
            .fields("authorId")
            .references("id"),
        })
        .map("posts");
      const tag = s
        .model({ id: s.string().id(), users: s.toMany(() => user) })
        .map("tags");
      return serializeModels(
        { user, post, tag, feed: s.view(() => post, QUERY).map("feed") },
        { migrationDriver: sqlite3MigrationDriver }
      ).views![0]!;
    })();
    expect(moved.hash).not.toBe(feed().hash);
    expect(moved.sql).not.toBe(feed().sql);
  });
});
