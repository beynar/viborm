import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const author = s
  .model({
    id: s.string().id(),
    name: s.string(),
    meta: s.json().nullable(),
    posts: s.toMany(() => post),
  })
  .map("trim_authors");
const post = s
  .model({
    id: s.string().id(),
    title: s.string().map("post_title"),
    data: s.json(),
    authorId: s.string(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
    comments: s.toMany(() => comment),
  })
  .map("trim_posts");
const comment = s
  .model({
    id: s.string().id(),
    body: s.string(),
    payload: s.json(),
    approved: s.boolean(),
    postId: s.string(),
    post: s
      .toOne(() => post)
      .fields("postId")
      .references("id"),
  })
  .map("trim_comments");
const node = s
  .model({
    id: s.string().id(),
    label: s.string(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => node)
      .fields("parentId")
      .references("id")
      .name("tree"),
    children: s.toMany(() => node).name("tree"),
  })
  .map("trim_nodes");
const schema = { author, post, comment, node };

/** A same-name alias on a bare qualified column (`"q0"."id" AS "id"`). */
const SAME_NAME_ALIAS = /(["`])(\w+)\1\.(["`])(\w+)\3 AS \3\4\3/;
const MAPPED_COLUMN_ALIAS = /\."post_title" AS "title"/;
const COALESCED_COUNT = /COALESCE\(\(SELECT COUNT\(\*\)/;
const VACUOUS_WALK_WHERE = /WHERE (TRUE|1)\s*\n/;

/**
 * The trimmed projection SQL answers what the untrimmed SQL answered: nested
 * JSON aggregates without a re-parse on SQLite and without a second COALESCE,
 * `_count` without a COALESCE, a recursive walk without `WHERE TRUE`, and on
 * PostgreSQL and MySQL a column without an alias that only repeats its name.
 * Every expected value is written from the seeded rows.
 */
export function runProjectionTrimsBehavior({
  name: provider,
  createDriver,
}: {
  readonly name: string;
  readonly createDriver: () => AnyDriver;
}) {
  describe(`${provider}: projection SQL trims`, () => {
    const clients: { $disconnect(): Promise<void> }[] = [];
    afterEach(async () => {
      for (const client of clients.splice(0)) await client.$disconnect();
    });

    const open = async () => {
      const driver = createDriver();
      const statements: string[] = [];
      const observed = driver as unknown as {
        execute: (...args: unknown[]) => Promise<unknown>;
      };
      const execute = observed.execute.bind(driver);
      observed.execute = (...args: unknown[]) => {
        statements.push(args[1] as string);
        return execute(...args);
      };
      const db = createClient({ schema, driver });
      clients.push(db);
      await syncLiveSchema(db);
      await db.author.createMany({
        data: [
          { id: "a1", name: "Ada", meta: { tags: ["x"], nested: { n: 1 } } },
          { id: "a2", name: "Bo" },
        ],
      });
      await db.post.createMany({
        data: [
          { id: "p1", title: "One", data: [1, { k: "v" }], authorId: "a1" },
          { id: "p2", title: "Two", data: { empty: [] }, authorId: "a1" },
        ],
      });
      await db.comment.createMany({
        data: [
          {
            id: "c1",
            body: "hi",
            payload: { emoji: "é✓", list: [1, 2] },
            approved: true,
            postId: "p1",
          },
          {
            id: "c2",
            body: "no",
            payload: "text",
            approved: false,
            postId: "p1",
          },
        ],
      });
      await db.node.createMany({
        data: [
          { id: "n1", label: "root", parentId: null },
          { id: "n2", label: "child", parentId: "n1" },
          { id: "n3", label: "leaf", parentId: "n2" },
        ],
      });
      statements.length = 0;
      return { db, statements, dialect: driver.dialect };
    };

    test(`${provider}: nested includes three deep keep their JSON documents`, async () => {
      const { db, statements, dialect } = await open();
      const authors = await db.author.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          meta: true,
          posts: {
            orderBy: { id: "asc" },
            select: {
              title: true,
              data: true,
              comments: {
                orderBy: { id: "asc" },
                select: {
                  payload: true,
                  post: { select: { title: true, data: true } },
                },
              },
            },
          },
        },
      });
      expect(authors).toEqual([
        {
          id: "a1",
          meta: { tags: ["x"], nested: { n: 1 } },
          posts: [
            {
              title: "One",
              data: [1, { k: "v" }],
              comments: [
                {
                  payload: { emoji: "é✓", list: [1, 2] },
                  post: { title: "One", data: [1, { k: "v" }] },
                },
                {
                  payload: "text",
                  post: { title: "One", data: [1, { k: "v" }] },
                },
              ],
            },
            { title: "Two", data: { empty: [] }, comments: [] },
          ],
        },
        { id: "a2", meta: null, posts: [] },
      ]);
      const [statement] = statements;
      expect(statement).not.toContain("COALESCE(COALESCE(");
      if (dialect === "sqlite") {
        expect(statement).toContain("json_group_array(json_object(");
        expect(statement).not.toContain("json_group_array(json(");
        expect(statement).toMatch(SAME_NAME_ALIAS);
      } else {
        expect(statement).not.toMatch(SAME_NAME_ALIAS);
        // A mapped column is still published under its field's name.
        expect(statement).toMatch(MAPPED_COLUMN_ALIAS);
      }
    });

    test(`${provider}: _count reads zero, filtered and unfiltered counts`, async () => {
      const { db, statements } = await open();
      const authors = await db.author.findMany({
        orderBy: { id: "asc" },
        select: { id: true, _count: { select: { posts: true } } },
      });
      const posts = await db.post.findMany({
        orderBy: { id: "asc" },
        select: {
          id: true,
          _count: {
            select: { comments: { where: { approved: true } } },
          },
        },
      });
      const ordered = await db.post.findMany({
        orderBy: [{ comments: { _count: "desc" } }, { id: "desc" }],
        select: { id: true },
      });
      expect(authors).toEqual([
        { id: "a1", _count: { posts: 2 } },
        { id: "a2", _count: { posts: 0 } },
      ]);
      expect(posts).toEqual([
        { id: "p1", _count: { comments: 1 } },
        { id: "p2", _count: { comments: 0 } },
      ]);
      expect(ordered).toEqual([{ id: "p1" }, { id: "p2" }]);
      for (const statement of statements)
        expect(statement).not.toMatch(COALESCED_COUNT);
    });

    test(`${provider}: an unbounded, unfiltered walk states no WHERE`, async () => {
      const { db, statements } = await open();
      const roots = await db.node.findMany({
        where: { id: "n1" },
        select: {
          label: true,
          children: { recurse: { depth: false }, select: { label: true } },
        },
      });
      expect(roots).toEqual([
        {
          label: "root",
          children: [
            { label: "child", children: [{ label: "leaf", children: [] }] },
          ],
        },
      ]);
      const [statement] = statements;
      expect(statement).toContain("WITH RECURSIVE");
      expect(statement).not.toMatch(VACUOUS_WALK_WHERE);
    });
  });
}
