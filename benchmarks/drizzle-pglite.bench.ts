/**
 * viborm vs drizzle vs raw — ALL ON ASYNC PGlite (Postgres-in-WASM).
 *
 * The apples-to-apples async comparison: unlike the better-sqlite3 bench (where
 * drizzle's driver is synchronous and viborm's is async — a per-call handicap
 * viborm pays), here ALL THREE run on the same async PGlite substrate, so the
 * numbers reflect ORM overhead, not sync-vs-async. Raw PGlite is the floor.
 * Identical schema, seed (100 users / 1000 posts), and queries.
 *
 * Run: pnpm vitest bench benchmarks/drizzle-pglite.bench.ts --run
 */
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { desc, eq, relations } from "drizzle-orm";
import { boolean, integer, pgTable, text } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { bench, describe } from "vitest";

const DDL_USERS =
  'CREATE TABLE "users" ("id" text primary key, "name" text, "email" text not null, "age" integer)';
const DDL_POSTS =
  'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" boolean not null, "views" integer not null, "authorId" text not null)';

const seedAsync = async (
  run: (sql: string, params: unknown[]) => Promise<unknown>
) => {
  for (let i = 0; i < 100; i++) {
    await run(
      'INSERT INTO "users" ("id","name","email","age") VALUES ($1,$2,$3,$4)',
      [`u${i}`, `User ${i}`, `u${i}@x.com`, 20 + (i % 50)]
    );
  }
  for (let i = 0; i < 1000; i++) {
    await run(
      'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES ($1,$2,$3,$4,$5,$6)',
      [`p${i}`, `Post ${i}`, `content ${i}`, i % 2 === 1, i, `u${i % 100}`]
    );
  }
};

// ---------- raw PGlite ----------
const rawPg = new PGlite();
await rawPg.exec(DDL_USERS);
await rawPg.exec(DDL_POSTS);
await seedAsync((sql, params) => rawPg.query(sql, params));

// ---------- viborm (PGliteDriver) ----------
const user = s
  .model({
    id: s.string().id(),
    name: s.string().nullable(),
    email: s.string(),
    age: s.int().nullable(),
    posts: s.toMany(() => post),
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
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const vibormDriver = new PGliteDriver();
const viborm = createClient({ schema: { user, post }, driver: vibormDriver });
await push(viborm, { force: true });
await seedAsync((sql, params) => vibormDriver._executeRaw(sql, params));

// ---------- drizzle (PGlite) ----------
const dUsers = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name"),
  email: text("email").notNull(),
  age: integer("age"),
});
const dPosts = pgTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  published: boolean("published").notNull(),
  views: integer("views").notNull(),
  authorId: text("authorId").notNull(),
});
const dUsersRel = relations(dUsers, ({ many }) => ({ posts: many(dPosts) }));
const dPostsRel = relations(dPosts, ({ one }) => ({
  author: one(dUsers, { fields: [dPosts.authorId], references: [dUsers.id] }),
}));
const drizzlePg = new PGlite();
await drizzlePg.exec(DDL_USERS);
await drizzlePg.exec(DDL_POSTS);
await seedAsync((sql, params) => drizzlePg.query(sql, params));
const ddb = drizzle(drizzlePg, {
  schema: {
    users: dUsers,
    posts: dPosts,
    usersRelations: dUsersRel,
    postsRelations: dPostsRel,
  },
});

// ---------- benches ----------
describe("pglite vs drizzle: findUnique by id", () => {
  bench("raw pglite", async () => {
    await rawPg.query('SELECT * FROM "users" WHERE "id" = $1 LIMIT 1', ["u42"]);
  });
  bench("drizzle", async () => {
    await ddb.select().from(dUsers).where(eq(dUsers.id, "u42")).limit(1);
  });
  bench("viborm", async () => {
    await viborm.user.findUnique({ where: { id: "u42" } });
  });
});

describe("pglite vs drizzle: findMany 20 rows, filter + order", () => {
  bench("raw pglite", async () => {
    await rawPg.query(
      'SELECT "id","title","views" FROM "posts" WHERE "published" = true ORDER BY "views" DESC LIMIT 20'
    );
  });
  bench("drizzle", async () => {
    await ddb
      .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
      .from(dPosts)
      .where(eq(dPosts.published, true))
      .orderBy(desc(dPosts.views))
      .limit(20);
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

describe("pglite vs drizzle: findMany 20 rows with nested relation", () => {
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

describe("pglite vs drizzle: insert 1 row", () => {
  let dId = 0;
  let vId = 0;
  bench("drizzle", async () => {
    await ddb
      .insert(dUsers)
      .values({ id: `d${dId++}`, name: "B", email: "b@x.com", age: 30 })
      .returning();
  });
  bench("viborm", async () => {
    await viborm.user.create({
      data: { id: `v${vId++}`, name: "B", email: "b@x.com", age: 30 },
    });
  });
});

describe("pglite vs drizzle: findMany 1000 rows", () => {
  bench("raw pglite", async () => {
    await rawPg.query('SELECT * FROM "posts" LIMIT 1000');
  });
  bench("drizzle", async () => {
    await ddb.select().from(dPosts).limit(1000);
  });
  bench("viborm", async () => {
    await viborm.post.findMany({ take: 1000 });
  });
});
