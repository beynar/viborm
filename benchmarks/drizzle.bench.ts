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
import { readTransactionOperation } from "@query-engine/transaction-operation";
import { s } from "@schema";
import Database from "better-sqlite3";
import { desc, eq, relations } from "drizzle-orm";
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
await push(viborm, { force: true });
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

function firstOrThrow<T>(rows: readonly T[], name: string): T {
  const first = rows[0];
  if (!first) throw new Error(`${name} returned no rows`);
  return first;
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
  take: 20,
} satisfies Parameters<typeof viborm.post.findMany>[0];
const relationPrepared = prepareOperation(
  viborm.post.findMany(relationArgs),
  "relation findMany"
);
const findMany1000Prepared = prepareOperation(
  viborm.post.findMany({ take: 1000 }),
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

let sink = 0;
function checksumRawRelation(rows: Record<string, unknown>[]): number {
  const first = rows[0];
  if (!first) return 0;
  for (const value of Object.values(first)) {
    if (typeof value === "string" && value.includes("User ")) {
      const nestedScalarOffset = value.indexOf("User ");
      return rows.length + value.charCodeAt(nestedScalarOffset + 5);
    }
  }
  throw new Error(
    "The exact relation SQL did not return a nested scalar carrier"
  );
}

// ---------- benches ----------

describe("vs drizzle: findUnique by id", () => {
  bench("raw better-sqlite3", () => {
    const row = rawDb
      .prepare(findUniquePrepared.sql)
      .get(...findUniquePrepared.params) as { age: number };
    sink += row.age;
  });

  bench("drizzle", () => {
    const rows = ddb
      .select()
      .from(dUsers)
      .where(eq(dUsers.id, "u42"))
      .limit(1)
      .all();
    sink += rows[0]?.age ?? 0;
  });

  bench("viborm", async () => {
    const row = await viborm.user.findUnique({ where: { id: "u42" } });
    if (!row) throw new Error("VibORM findUnique returned no row");
    sink += row.age ?? 0;
  });
});

describe("vs drizzle: findMany 20 rows, filter + order", () => {
  bench("raw better-sqlite3", () => {
    const rows = rawDb
      .prepare(findManyPrepared.sql)
      .all(...findManyPrepared.params) as Array<{ views: number }>;
    sink += rows.length + firstOrThrow(rows, "raw findMany 20").views;
  });

  bench("drizzle", () => {
    const rows = ddb
      .select({ id: dPosts.id, title: dPosts.title, views: dPosts.views })
      .from(dPosts)
      .where(eq(dPosts.published, 1))
      .orderBy(desc(dPosts.views))
      .limit(20)
      .all();
    sink += rows.length + firstOrThrow(rows, "Drizzle findMany 20").views;
  });

  bench("viborm", async () => {
    const rows = await viborm.post.findMany({
      where: { published: true },
      select: { id: true, title: true, views: true },
      orderBy: { views: "desc" },
      take: 20,
    });
    sink += rows.length + firstOrThrow(rows, "VibORM findMany 20").views;
  });
});

describe("vs drizzle: findMany 20 rows with nested relation", () => {
  bench("raw better-sqlite3 (exact nested-result SQL)", () => {
    const rows = rawDb
      .prepare(relationPrepared.sql)
      .all(...relationPrepared.params) as Record<string, unknown>[];
    sink += checksumRawRelation(rows);
  });

  bench("drizzle relational query", async () => {
    const rows = await ddb.query.posts.findMany({
      columns: { id: true, title: true },
      with: { author: { columns: { id: true, name: true } } },
      limit: 20,
    });
    sink +=
      rows.length +
      (firstOrThrow(rows, "Drizzle relation read").author?.name?.charCodeAt(
        5
      ) ?? 0);
  });

  bench("viborm include", async () => {
    const rows = await viborm.post.findMany(relationArgs);
    sink +=
      rows.length +
      (firstOrThrow(rows, "VibORM relation read").author?.name?.charCodeAt(5) ??
        0);
  });
});

describe("vs drizzle: insert 1 row", () => {
  let rawId = 0;
  let drizzleId = 0;
  let vibormId = 0;

  bench("raw better-sqlite3", () => {
    rawCreateParams[rawCreateIdIndex] = `r${rawId++}`;
    const row = rawDb.prepare(createPrepared.sql).get(...rawCreateParams) as {
      age: number;
    };
    sink += row.age;
  });

  bench("drizzle", () => {
    const rows = ddb
      .insert(dUsers)
      .values({ id: `d${drizzleId++}`, name: "B", email: "b@x.com", age: 30 })
      .returning()
      .all();
    sink += rows.length + (rows[0]?.age ?? 0);
  });

  bench("viborm", async () => {
    const row = await viborm.user.create({
      data: { id: `v${vibormId++}`, name: "B", email: "b@x.com", age: 30 },
    });
    sink += row.age ?? 0;
  });
});

describe("vs drizzle: findMany 1000 rows", () => {
  bench("raw better-sqlite3", () => {
    const rows = rawDb
      .prepare(findMany1000Prepared.sql)
      .all(...findMany1000Prepared.params) as Array<{ views: number }>;
    sink += rows.length + firstOrThrow(rows, "raw findMany 1000").views;
  });

  bench("drizzle", () => {
    const rows = ddb.select().from(dPosts).limit(1000).all();
    sink += rows.length + firstOrThrow(rows, "Drizzle findMany 1000").views;
  });

  bench("viborm", async () => {
    const rows = await viborm.post.findMany({ take: 1000 });
    sink += rows.length + firstOrThrow(rows, "VibORM findMany 1000").views;
  });
});

afterAll(async () => {
  if (sink < 0) throw new Error("Unreachable benchmark sink");
  rawDb.close();
  drizzleSqlite.close();
  await vibormDriver.disconnect();
});
