/**
 * viborm vs drizzle vs raw benchmarks.
 *
 * Identical schema, data, and queries on three separate in-memory SQLite
 * databases. Raw better-sqlite3 is the floor. Note drizzle's better-sqlite3
 * driver is synchronous while viborm's is fully async — a structural handicap
 * viborm pays here that disappears on network drivers.
 *
 * Run: pnpm bench
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { s } from "@schema";
import Database from "better-sqlite3";
import { desc, eq, relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { bench, describe } from "vitest";

const DDL_USERS =
  'CREATE TABLE "users" ("id" text primary key, "name" text, "email" text not null, "age" integer)';
const DDL_POSTS =
  'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" integer not null, "views" integer not null, "authorId" text not null)';

const seed = (run: (sql: string, params: unknown[]) => unknown) => {
  for (let i = 0; i < 100; i++) {
    run('INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?)', [
      `u${i}`,
      `User ${i}`,
      `u${i}@x.com`,
      20 + (i % 50),
    ]);
  }
  for (let i = 0; i < 1000; i++) {
    run(
      'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)',
      [`p${i}`, `Post ${i}`, `content ${i}`, i % 2, i, `u${i % 100}`]
    );
  }
};

// ---------- raw better-sqlite3 ----------
const rawDb = new Database(":memory:");
rawDb.exec(DDL_USERS);
rawDb.exec(DDL_POSTS);
seed((sql, params) => rawDb.prepare(sql).run(...params));

// ---------- viborm ----------
const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.oneToMany(() => post),
  })
  .map("users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    content: s.string().nullable(),
    published: s.boolean().default(false),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const vibormDriver = new SQLite3Driver({ dataDir: ":memory:" });
const viborm = createClient({ schema: { user, post }, driver: vibormDriver });
await push(viborm, { force: true });
seed((sql, params) => vibormDriver._executeRaw(sql, params));

// ---------- drizzle ----------
const dUsers = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull(),
  age: integer("age"),
});
const dPosts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  published: integer("published").notNull(),
  views: integer("views").notNull(),
  authorId: text("authorId").notNull(),
});
const dUsersRel = relations(dUsers, ({ many }) => ({ posts: many(dPosts) }));
const dPostsRel = relations(dPosts, ({ one }) => ({
  author: one(dUsers, { fields: [dPosts.authorId], references: [dUsers.id] }),
}));
const drizzleSqlite = new Database(":memory:");
drizzleSqlite.exec(DDL_USERS);
drizzleSqlite.exec(DDL_POSTS);
seed((sql, params) => drizzleSqlite.prepare(sql).run(...params));
const ddb = drizzle(drizzleSqlite, {
  schema: {
    users: dUsers,
    posts: dPosts,
    usersRelations: dUsersRel,
    postsRelations: dPostsRel,
  },
});

// ---------- benches ----------

describe("vs drizzle: findUnique by id", () => {
  bench("raw better-sqlite3", () => {
    rawDb.prepare('SELECT * FROM "users" WHERE "id" = ? LIMIT 1').get("u42");
  });

  bench("drizzle", () => {
    ddb.select().from(dUsers).where(eq(dUsers.id, "u42")).limit(1).all();
  });

  bench("viborm", async () => {
    await viborm.user.findUnique({ where: { id: "u42" } });
  });
});

describe("vs drizzle: findMany 20 rows, filter + order", () => {
  bench("raw better-sqlite3", () => {
    rawDb
      .prepare(
        'SELECT "id","title","views" FROM "posts" WHERE "published" = 1 ORDER BY "views" DESC LIMIT 20'
      )
      .all();
  });

  bench("drizzle", () => {
    ddb
      .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
      .from(dPosts)
      .where(eq(dPosts.published, 1))
      .orderBy(desc(dPosts.views))
      .limit(20)
      .all();
  });

  bench("viborm", async () => {
    await viborm.post.findMany({
      where: { published: true },
      select: { id: true, title: true, views: true },
      orderBy: { views: "desc" },
      take: 20,
    });
  });
});

describe("vs drizzle: findMany 20 rows with nested relation", () => {
  bench("raw better-sqlite3 (flat join, not nested)", () => {
    rawDb
      .prepare(
        'SELECT p."id", p."title", u."id" as aid, u."name" as aname FROM "posts" p JOIN "users" u ON u."id" = p."authorId" LIMIT 20'
      )
      .all();
  });

  bench("drizzle relational query", async () => {
    await ddb.query.posts.findMany({
      columns: { id: true, title: true },
      with: { author: { columns: { id: true, name: true } } },
      limit: 20,
    });
  });

  bench("viborm include", async () => {
    await viborm.post.findMany({
      select: {
        id: true,
        title: true,
        author: { select: { id: true, name: true } },
      },
      take: 20,
    });
  });
});

describe("vs drizzle: insert 1 row", () => {
  let rawId = 0;
  let drizzleId = 0;
  let vibormId = 0;

  bench("raw better-sqlite3", () => {
    rawDb
      .prepare(
        'INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?) RETURNING *'
      )
      .get(`r${rawId++}`, "B", "b@x.com", 30);
  });

  bench("drizzle", () => {
    ddb
      .insert(dUsers)
      .values({ id: `d${drizzleId++}`, name: "B", email: "b@x.com", age: 30 })
      .returning()
      .all();
  });

  bench("viborm", async () => {
    await viborm.user.create({
      data: { id: `v${vibormId++}`, name: "B", email: "b@x.com", age: 30 },
    });
  });
});

describe("vs drizzle: findMany 1000 rows", () => {
  bench("raw better-sqlite3", () => {
    rawDb.prepare('SELECT * FROM "posts" LIMIT 1000').all();
  });

  bench("drizzle", () => {
    ddb.select().from(dPosts).limit(1000).all();
  });

  bench("viborm", async () => {
    await viborm.post.findMany({ take: 1000 });
  });
});
