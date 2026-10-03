// biome-ignore-all lint/suspicious/noMisplacedAssertion: benchmark witnesses reject unequal public results before timing.
/**
 * viborm vs drizzle vs raw benchmarks.
 *
 * Identical schema, data, and queries on three separate in-memory SQLite
 * databases. Raw better-sqlite3 is the floor. Note drizzle's better-sqlite3
 * driver is synchronous while viborm's is fully async — a structural handicap
 * viborm pays here. Network latency can obscure that overhead.
 * Raw returns physical values; it is a SQL execution floor, not a decoded ORM result.
 *
 * Run: pnpm bench
 */
import assert from "node:assert/strict";
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { pushV1 as push } from "@migrations/push-v1";
import { readTransactionOperation } from "@query-engine/transaction-operation";
import { s } from "@schema";
import Database from "better-sqlite3";
import { asc, desc, eq, relations } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { afterAll, bench, describe } from "vitest";

const DDL_USERS =
  'CREATE TABLE "users" ("id" text primary key, "name" text, "email" text not null, "age" integer)';
const DDL_POSTS =
  'CREATE TABLE "posts" ("id" text primary key, "title" text not null, "content" text, "published" integer not null, "views" integer not null, "authorId" text not null)';

const seed = async (
  run: (sql: string, params: unknown[]) => unknown | Promise<unknown>
) => {
  for (let i = 0; i < 100; i++) {
    await run(
      'INSERT INTO "users" ("id","name","email","age") VALUES (?,?,?,?)',
      [`u${i}`, `User ${i}`, `u${i}@x.com`, 20 + (i % 50)]
    );
  }
  for (let i = 0; i < 1000; i++) {
    await run(
      'INSERT INTO "posts" ("id","title","content","published","views","authorId") VALUES (?,?,?,?,?,?)',
      [`p${i}`, `Post ${i}`, `content ${i}`, i % 2, i, `u${i % 100}`]
    );
  }
};

// ---------- raw better-sqlite3 ----------
const rawDb = new Database(":memory:");
rawDb.exec(DDL_USERS);
rawDb.exec(DDL_POSTS);
await seed((sql, params) => rawDb.prepare(sql).run(...params));

// ---------- viborm ----------
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
const vibormDriver = new SQLite3Driver({ dataDir: ":memory:" });
const viborm = createClient({ schema: { user, post }, driver: vibormDriver });
await push(viborm);
await seed((sql, params) => vibormDriver._executeRaw(sql, params));

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
  published: integer("published", { mode: "boolean" }).notNull(),
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
await seed((sql, params) => drizzleSqlite.prepare(sql).run(...params));
const ddb = drizzle(drizzleSqlite, {
  schema: {
    users: dUsers,
    posts: dPosts,
    usersRelations: dUsersRel,
    postsRelations: dPostsRel,
  },
});

function preparedOrThrow<T>(prepared: T | undefined, name: string): T {
  if (!prepared)
    throw new Error(`${name} did not produce a prepared statement`);
  return prepared;
}

function prepareTransactionOperation(operation: unknown) {
  if (operation === null || typeof operation !== "object") {
    throw new Error("Expected a VibORM benchmark operation");
  }
  const owner = readTransactionOperation(operation);
  if (!owner) throw new Error("Expected a VibORM benchmark operation");
  return owner.prepare(operation);
}

function prepareOperation(operation: unknown, name: string) {
  return preparedOrThrow(prepareTransactionOperation(operation), name);
}

const findUniquePrepared = prepareOperation(
  viborm.user.findUnique({ where: { id: "u42" } }),
  "findUnique"
);
const findManyPrepared = prepareOperation(
  viborm.post.findMany({
    where: { published: true },
    select: { id: true, title: true, views: true },
    orderBy: { views: "desc" },
    take: 20,
  }),
  "findMany 20"
);
const relationArgs = {
  select: {
    id: true,
    title: true,
    author: { select: { id: true, name: true } },
  },
  orderBy: { id: "asc" },
  take: 20,
} satisfies Parameters<typeof viborm.post.findMany>[0];
const relationPrepared = prepareOperation(
  viborm.post.findMany(relationArgs),
  "relation findMany"
);
const findMany1000Prepared = prepareOperation(
  viborm.post.findMany({ orderBy: { id: "asc" }, take: 1000 }),
  "findMany 1000"
);
const rawCreateTemplateId = "__raw_drizzle_id__";
const createPrepared = preparedOrThrow(
  (() => {
    const operation = viborm.user.create({
      data: {
        id: rawCreateTemplateId,
        name: "B",
        email: "b@x.com",
        age: 30,
      },
    });
    const prepared = prepareTransactionOperation(operation);
    if (prepared) return prepared;
    const statement = operation.buildStatement();
    return statement ? vibormDriver._prepare(statement) : undefined;
  })(),
  "create"
);
const createPreparedParams = createPrepared.params ?? [];
const rawCreateIdIndex = createPreparedParams.indexOf(rawCreateTemplateId);
if (rawCreateIdIndex < 0) {
  throw new Error(
    "The prepared create statement did not expose its ID parameter"
  );
}
const rawCreateParams = [...createPreparedParams];

// Validate complete public results before timing. Raw executes the exact VibORM
// SQL but keeps physical booleans and relation carriers; it is only a floor.
const expectedPosts = Array.from({ length: 1000 }, (_, i) => ({
  id: `p${i}`,
  title: `Post ${i}`,
  content: `content ${i}`,
  published: Boolean(i % 2),
  views: i,
  authorId: `u${i % 100}`,
}));
const orderedPosts = [...expectedPosts].sort((left, right) => {
  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
});
const expectedUser = {
  id: "u42",
  name: "User 42",
  email: "u42@x.com",
  age: 62,
};
const expectedFiltered = expectedPosts
  .filter((row) => row.published)
  .reverse()
  .slice(0, 20)
  .map(({ id, title, views }) => ({ id, title, views }));
const expectedRelation = orderedPosts
  .slice(0, 20)
  .map(({ id, title, authorId }) => ({
    id,
    title,
    author: { id: authorId, name: `User ${authorId.slice(1)}` },
  }));
let rawId = 0;
let drizzleId = 0;
let vibormId = 0;
const inserted = (id: string) => ({ id, name: "B", email: "b@x.com", age: 30 });
const rawFilteredParams = findManyPrepared.params.map((value) =>
  typeof value === "boolean" ? Number(value) : value
);
const queries = {
  unique: {
    raw: () =>
      rawDb.prepare(findUniquePrepared.sql).get(...findUniquePrepared.params),
    drizzle: () =>
      ddb.select().from(dUsers).where(eq(dUsers.id, "u42")).limit(1).get(),
    viborm: () => viborm.user.findUnique({ where: { id: "u42" } }),
  },
  filtered: {
    raw: () => rawDb.prepare(findManyPrepared.sql).all(...rawFilteredParams),
    drizzle: () =>
      ddb
        .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
        .from(dPosts)
        .where(eq(dPosts.published, true))
        .orderBy(desc(dPosts.views))
        .limit(20)
        .all(),
    viborm: () =>
      viborm.post.findMany({
        where: { published: true },
        select: { id: true, title: true, views: true },
        orderBy: { views: "desc" },
        take: 20,
      }),
  },
  relation: {
    raw: () =>
      rawDb.prepare(relationPrepared.sql).all(...relationPrepared.params),
    drizzle: () =>
      ddb.query.posts.findMany({
        columns: { id: true, title: true },
        with: { author: { columns: { id: true, name: true } } },
        orderBy: [asc(dPosts.id)],
        limit: 20,
      }),
    viborm: () => viborm.post.findMany(relationArgs),
  },
  insert: {
    raw: () => {
      rawCreateParams[rawCreateIdIndex] = `r${rawId++}`;
      return rawDb.prepare(createPrepared.sql).get(...rawCreateParams);
    },
    drizzle: () =>
      ddb
        .insert(dUsers)
        .values(inserted(`d${drizzleId++}`))
        .returning()
        .get(),
    viborm: () => viborm.user.create({ data: inserted(`v${vibormId++}`) }),
  },
  rows1000: {
    raw: () =>
      rawDb
        .prepare(findMany1000Prepared.sql)
        .all(...findMany1000Prepared.params),
    drizzle: () =>
      ddb.select().from(dPosts).orderBy(asc(dPosts.id)).limit(1000).all(),
    viborm: () => viborm.post.findMany({ orderBy: { id: "asc" }, take: 1000 }),
  },
};
for (const library of ["drizzle", "viborm"] as const) {
  assert.deepStrictEqual(await queries.unique[library](), expectedUser);
  assert.deepStrictEqual(await queries.filtered[library](), expectedFiltered);
  assert.deepStrictEqual(await queries.relation[library](), expectedRelation);
  assert.deepStrictEqual(await queries.rows1000[library](), orderedPosts);
}
assert.deepStrictEqual(await queries.insert.drizzle(), inserted("d0"));
assert.deepStrictEqual(await queries.insert.viborm(), inserted("v0"));
assert.deepStrictEqual(queries.insert.raw(), inserted("r0"));
assert.deepStrictEqual(queries.unique.raw(), expectedUser);
assert.deepStrictEqual(queries.filtered.raw(), expectedFiltered);
assert.equal(queries.relation.raw().length, expectedRelation.length);
assert.deepStrictEqual(
  queries.rows1000.raw(),
  orderedPosts.map((row) => ({
    ...row,
    published: Number(row.published),
  }))
);

let sink = 0;
for (const [name, workload] of Object.entries(queries)) {
  describe(`vs drizzle: ${name}`, () => {
    for (const [library, query] of Object.entries(workload)) {
      bench(library, async () => {
        const rows = await query();
        sink += Array.isArray(rows) ? rows.length : Number(rows !== undefined);
      });
    }
  });
}
afterAll(async () => {
  if (sink < 0) throw new Error("Unreachable benchmark sink");
  rawDb.close();
  drizzleSqlite.close();
  await vibormDriver.disconnect();
});
