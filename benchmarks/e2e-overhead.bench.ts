/**
 * End-to-end overhead benchmarks.
 *
 * Runs full viborm client operations against raw SQL strings on the SAME
 * in-memory SQLite database. Since the database work is identical, the gap
 * between each pair IS viborm's total per-query overhead (validation +
 * query building + result parsing). This is the "distance from raw" metric.
 *
 * Run: pnpm bench
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

const driver = new SQLite3Driver({ dataDir: ":memory:" });
const client = createClient({ schema: sqliteUserPostSchema, driver });
await push(client, { force: true });

const USERS = 100;
const POSTS = 1000;
for (let i = 0; i < USERS; i++) {
  await driver._executeRaw(
    'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
    [`user_${i}`, `User ${i}`, `user${i}@example.com`, 20 + (i % 50)]
  );
}
for (let i = 0; i < POSTS; i++) {
  await driver._executeRaw(
    'INSERT INTO "posts" ("id", "title", "content", "published", "views", "authorId") VALUES (?, ?, ?, ?, ?, ?)',
    [`post_${i}`, `Post ${i}`, `Content ${i}`, i % 2, i, `user_${i % USERS}`]
  );
}

describe("e2e: read one row by id", () => {
  bench("raw SQL string", async () => {
    await driver._executeRaw('SELECT * FROM "users" WHERE "id" = ? LIMIT 1', [
      "user_42",
    ]);
  });

  bench("viborm findUnique", async () => {
    await client.user.findUnique({ where: { id: "user_42" } });
  });
});

describe("e2e: read 20 rows with filter + order", () => {
  bench("raw SQL string", async () => {
    await driver._executeRaw(
      'SELECT "id", "title", "views" FROM "posts" WHERE "published" = ? ORDER BY "views" DESC LIMIT 20',
      [1]
    );
  });

  bench("viborm findMany", async () => {
    await client.post.findMany({
      where: { published: true },
      select: { id: true, title: true, views: true },
      orderBy: { views: "desc" },
      take: 20,
    });
  });
});

describe("e2e: read 20 rows with relation", () => {
  const args = {
    select: {
      id: true,
      title: true,
      author: { select: { id: true, name: true } },
    },
    take: 20,
  } satisfies Parameters<typeof client.post.findMany>[0];
  const prepared = client.post.findMany(args).prepare();
  if (!prepared) {
    throw new Error("The relation read did not produce one prepared statement");
  }

  bench("raw exact prepared SQL", async () => {
    await driver._executeRaw(prepared.sql, prepared.params);
  });

  bench("viborm findMany with include", async () => {
    await client.post.findMany(args);
  });
});

describe("e2e: insert one row", () => {
  let rawId = 0;
  let ormId = 0;

  bench("raw SQL string", async () => {
    await driver._executeRaw(
      'INSERT INTO "users" ("id", "name", "email", "age") VALUES (?, ?, ?, ?)',
      [`raw_${rawId++}`, "Bench", "bench@example.com", 30]
    );
  });

  bench("viborm create", async () => {
    await client.user.create({
      data: {
        id: `orm_${ormId++}`,
        name: "Bench",
        email: "bench@example.com",
        age: 30,
      },
    });
  });
});
