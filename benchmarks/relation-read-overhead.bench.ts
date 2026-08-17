/**
 * Relation-read overhead with equivalent database work.
 *
 * The raw and parsed cases execute the exact SQL and parameters prepared by
 * VibORM. This keeps the database work identical and isolates preparation and
 * result parsing from the complete client operation.
 *
 * Run:
 *   pnpm vitest bench benchmarks/relation-read-overhead.bench.ts --run --project layer-query-engine
 */
import { createClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { afterAll, bench, describe } from "vitest";
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

const args = {
  select: {
    id: true,
    title: true,
    author: { select: { id: true, name: true } },
  },
  take: 20,
} satisfies Parameters<typeof client.post.findMany>[0];

const preparedOperation = client.post.findMany(args);
const prepared = preparedOperation.prepare();
if (!prepared) {
  throw new Error("The relation read did not produce one prepared statement");
}
const rawFixture = await driver._executeRaw(prepared.sql, prepared.params);
const expected = preparedOperation.parseResult(rawFixture);
if (!Array.isArray(expected) || expected.length !== 20) {
  throw new Error("The relation-read fixture did not return 20 parsed rows");
}

const largeArgs = { ...args, take: 1_000 } satisfies Parameters<
  typeof client.post.findMany
>[0];
const largePreparedOperation = client.post.findMany(largeArgs);
const largePrepared = largePreparedOperation.prepare();
if (!largePrepared) {
  throw new Error("The large relation read did not produce a prepared statement");
}
const largeRawFixture = await driver._executeRaw(
  largePrepared.sql,
  largePrepared.params
);
const largeExpected = largePreparedOperation.parseResult(largeRawFixture);
if (!Array.isArray(largeExpected) || largeExpected.length !== 1_000) {
  throw new Error("The large relation-read fixture did not return 1,000 rows");
}

let sink = 0;

describe("relation read: exact prepared SQL", () => {
  bench("raw driver execution", async () => {
    const raw = await driver._executeRaw(prepared.sql, prepared.params);
    sink += raw.rows.length;
  });

  bench("raw execution + prepared result parser", async () => {
    const raw = await driver._executeRaw(prepared.sql, prepared.params);
    const rows = preparedOperation.parseResult(raw);
    sink += rows.length;
  });

  bench("full VibORM operation", async () => {
    const rows = await client.post.findMany(args);
    sink += rows.length;
  });
});

describe("relation read: CPU stages", () => {
  bench("dispatch + validate + build", () => {
    const operation = client.post.findMany(args);
    const query = operation.prepare();
    sink += query?.params.length ?? 0;
  });

  bench("prepared result parser only", () => {
    const rows = preparedOperation.parseResult(rawFixture);
    sink += rows.length;
  });
});

describe("relation read: parser scaling", () => {
  bench("prepared result parser, 1,000 rows", () => {
    const rows = largePreparedOperation.parseResult(largeRawFixture);
    sink += rows.length;
  });
});

afterAll(async () => {
  if (sink < 0) throw new Error("Unreachable benchmark sink");
  await driver.disconnect();
});
