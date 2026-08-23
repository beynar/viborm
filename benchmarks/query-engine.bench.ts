/**
 * Query builder benchmarks.
 *
 * Measures `engine.build()` — args → SQL string + params — against the floor:
 * a hand-written SQL string. The ratio to the baseline is the query-builder
 * overhead viborm adds on top of raw SQL.
 *
 * Run: pnpm bench
 */
import { PgDriver } from "@drivers/pg";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import { s } from "@schema";
import { hydrateSchemaNames } from "@schema/hydration";
import { createSchemaRegistry } from "@validation";
import { bench, describe } from "vitest";

const Author = s.model({
  id: s.string().id(),
  name: s.string(),
  email: s.string().unique(),
  posts: s.toMany(() => Post),
});

const Post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    authorId: s.string(),
    author: s
      .toOne(() => Author)
      .fields("authorId")
      .references("id"),
    tags: s.toMany(() => Tag),
  })
  .map("posts");

const Tag = s
  .model({
    id: s.string().id(),
    name: s.string().unique(),
    posts: s.toMany(() => Post),
  })
  .map("tags");

// build() never executes queries, so the pg pool stays unconnected
const driver = new PgDriver();
const schema = { Author, Post, Tag };
hydrateSchemaNames(schema);
const registry = createModelRegistry(schema, createSchemaRegistry(schema));
const engine = new QueryEngine(driver, registry);

// written to by the baseline bench so the object is never dead-code eliminated
const sink: { sql: string; params: unknown[] }[] = [];

describe("build: simple queries", () => {
  bench("baseline: hand-written SQL string", () => {
    sink.length = 0;
    sink.push({
      sql: 'SELECT "id", "title" FROM "posts" WHERE "published" = $1',
      params: [true],
    });
  });

  bench("findMany: simple where", () => {
    engine.build(Post, "findMany", { where: { published: true } });
  });

  bench("findMany: select fields", () => {
    engine.build(Post, "findMany", {
      select: { id: true, title: true },
      where: { published: true },
    });
  });
});

describe("build: relation includes", () => {
  bench("oneToMany include", () => {
    engine.build(Author, "findMany", {
      select: { id: true, posts: { select: { id: true, title: true } } },
    });
  });

  bench("manyToOne include", () => {
    engine.build(Post, "findMany", {
      select: { id: true, author: { select: { id: true, name: true } } },
    });
  });

  bench("m2m include", () => {
    engine.build(Post, "findMany", {
      select: {
        id: true,
        title: true,
        tags: { select: { id: true, name: true } },
      },
    });
  });

  bench("m2m include with where", () => {
    engine.build(Post, "findMany", {
      select: {
        id: true,
        tags: {
          where: { name: { startsWith: "type" } },
          select: { id: true, name: true },
        },
      },
    });
  });
});

describe("build: relation filters", () => {
  bench("m2m some", () => {
    engine.build(Post, "findMany", {
      where: { tags: { some: { name: "typescript" } } },
    });
  });

  bench("m2m every", () => {
    engine.build(Post, "findMany", {
      where: { tags: { every: { name: { startsWith: "type" } } } },
    });
  });

  bench("m2m none", () => {
    engine.build(Post, "findMany", {
      where: { tags: { none: { name: "deprecated" } } },
    });
  });
});

describe("build: counts", () => {
  bench("m2m _count", () => {
    engine.build(Post, "findMany", {
      select: { id: true, _count: { select: { tags: true } } },
    });
  });

  bench("m2m _count with where", () => {
    engine.build(Post, "findMany", {
      select: {
        id: true,
        _count: {
          select: { tags: { where: { name: { contains: "script" } } } },
        },
      },
    });
  });
});
