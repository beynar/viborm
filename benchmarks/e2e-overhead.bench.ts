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
import { readTransactionOperation } from "@query-engine/transaction-operation";
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

let sink = 0;

function preparedOrThrow<T>(prepared: T | undefined): T {
  if (!prepared)
    throw new Error("Benchmark operation did not prepare one statement");
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

function prepareOperation(operation: unknown) {
  return preparedOrThrow(prepareTransactionOperation(operation));
}

function prepareMutationForRaw(
  operation: ReturnType<typeof client.user.create>
) {
  const prepared = prepareTransactionOperation(operation);
  if (prepared) return prepared;
  const statement = operation.buildStatement();
  if (!statement)
    throw new Error("Benchmark mutation did not build one statement");
  return driver._prepare(statement);
}

function firstOrThrow<T>(rows: readonly T[], name: string): T {
  const first = rows[0];
  if (!first) throw new Error(`${name} returned no rows`);
  return first;
}

const findUniquePrepared = prepareOperation(
  client.user.findUnique({ where: { id: "user_42" } })
);
const findManyArgs = {
  where: { published: true },
  select: { id: true, title: true, views: true },
  orderBy: { views: "desc" },
  take: 20,
} satisfies Parameters<typeof client.post.findMany>[0];
const findManyPrepared = prepareOperation(client.post.findMany(findManyArgs));

describe("e2e: read one row by id", () => {
  bench("raw SQL string", async () => {
    const raw = await driver._executeRaw(
      findUniquePrepared.sql,
      findUniquePrepared.params
    );
    sink += Number(raw.rows[0]?.age ?? 0);
  });

  bench("viborm findUnique", async () => {
    const row = await client.user.findUnique({ where: { id: "user_42" } });
    if (!row) throw new Error("VibORM findUnique returned no row");
    sink += row.age ?? 0;
  });
});

describe("e2e: read 20 rows with filter + order", () => {
  bench("raw SQL string", async () => {
    const raw = await driver._executeRaw(
      findManyPrepared.sql,
      findManyPrepared.params
    );
    sink += raw.rows.length + Number(raw.rows[0]?.views ?? 0);
  });

  bench("viborm findMany", async () => {
    const rows = await client.post.findMany(findManyArgs);
    sink += rows.length + firstOrThrow(rows, "VibORM findMany").views;
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
  const prepared = prepareTransactionOperation(client.post.findMany(args));
  if (!prepared) {
    throw new Error("The relation read did not produce one prepared statement");
  }

  bench("raw exact prepared SQL", async () => {
    const raw = await driver._executeRaw(prepared.sql, prepared.params);
    const carrier = Object.values(raw.rows[0] ?? {}).find(
      (value) => typeof value === "string" && value.includes("User ")
    );
    if (typeof carrier !== "string") {
      throw new Error(
        "The exact relation SQL did not return its nested carrier"
      );
    }
    sink += raw.rows.length + carrier.charCodeAt(carrier.indexOf("User ") + 5);
  });

  bench("viborm findMany with include", async () => {
    const rows = await client.post.findMany(args);
    sink +=
      rows.length +
      (firstOrThrow(rows, "VibORM relation read").author?.name?.charCodeAt(5) ??
        0);
  });
});

describe("e2e: insert one row", () => {
  let rawId = 0;
  let ormId = 0;
  const rawTemplateId = "__raw_e2e_id__";
  const rawOperation = client.user.create({
    data: {
      id: rawTemplateId,
      name: "Bench",
      email: "bench@example.com",
      age: 30,
    },
  });
  const rawPrepared = prepareMutationForRaw(rawOperation);
  const rawPreparedParams = rawPrepared.params ?? [];
  const rawIdIndex = rawPreparedParams.indexOf(rawTemplateId);
  if (rawIdIndex < 0)
    throw new Error("The raw create floor lost its ID parameter");
  const rawParams = [...rawPreparedParams];

  bench("raw SQL string", async () => {
    rawParams[rawIdIndex] = `raw_${rawId++}`;
    const raw = await driver._executeRaw(rawPrepared.sql, rawParams);
    sink += Number(raw.rows[0]?.age ?? raw.rowCount);
  });

  bench("viborm create", async () => {
    const row = await client.user.create({
      data: {
        id: `orm_${ormId++}`,
        name: "Bench",
        email: "bench@example.com",
        age: 30,
      },
    });
    sink += row.age ?? 0;
  });
});

afterAll(async () => {
  if (sink < 0) throw new Error("Unreachable benchmark sink");
  await driver.disconnect();
});
