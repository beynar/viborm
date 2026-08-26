/**
 * Phase 0 operation-lifecycle baseline.
 *
 * Covers the exact paths migrated by the operation-program plan: deferred
 * operation creation, one-step preparation, direct writes, non-RETURNING
 * write emulation, and relation-bearing writes.
 *
 * Run: pnpm vitest bench --run benchmarks/operation-lifecycle.bench.ts
 */
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { push } from "@migrations";
import { readTransactionOperation } from "@query-engine/transaction-operation";
import { type Sql, sql } from "@sql";
import { bench, describe } from "vitest";
import { sqliteUserPostSchema } from "../tests/fixtures/user-post-schema";

class NonReturningPostgresAdapter
  extends PostgresAdapter
  implements DatabaseAdapter
{
  constructor() {
    super();
    this.capabilities = { ...this.capabilities, supportsReturning: false };
    this.mutations = {
      ...this.mutations,
      returning: (_columns: Sql): Sql => sql.empty,
    };
  }
}

class NonReturningPGliteDriver extends PGliteDriver {
  override readonly adapter: DatabaseAdapter =
    new NonReturningPostgresAdapter();
}

const sqliteDriver = new SQLite3Driver({ dataDir: ":memory:" });
const sqliteClient = createClient({
  schema: sqliteUserPostSchema,
  driver: sqliteDriver,
});
await push(sqliteClient, { force: true });

const nonReturningDriver = new NonReturningPGliteDriver();
const nonReturningClient = createClient({
  schema: sqliteUserPostSchema,
  driver: nonReturningDriver,
});
await push(nonReturningClient, { force: true });

await sqliteClient.user.create({
  data: {
    id: "direct-write-user",
    name: "Direct",
    email: "direct@example.com",
    age: 30,
  },
});
await sqliteClient.user.create({
  data: {
    id: "nested-write-user",
    name: "Nested",
    email: "nested@example.com",
    age: 30,
  },
});
await nonReturningClient.user.create({
  data: {
    id: "non-returning-user",
    name: "Non-returning",
    email: "non-returning@example.com",
    age: 30,
  },
});

const pendingSink: unknown[] = [];
const preparedSink: unknown[] = [];
let nestedPostId = 0;

function prepareTransactionOperation(operation: unknown) {
  if (operation === null || typeof operation !== "object") {
    throw new Error("Expected a VibORM benchmark operation");
  }
  const owner = readTransactionOperation(operation);
  if (!owner) throw new Error("Expected a VibORM benchmark operation");
  return owner.prepare(operation);
}

describe("operation lifecycle", () => {
  bench("create deferred one-step read", () => {
    pendingSink.length = 0;
    pendingSink.push(
      sqliteClient.user.findMany({
        where: { age: { gte: 18 } },
        take: 20,
      })
    );
  });

  bench("prepare deferred one-step read", () => {
    preparedSink.length = 0;
    const operation = sqliteClient.user.findMany({
      where: { age: { gte: 18 } },
      take: 20,
    });
    preparedSink.push(prepareTransactionOperation(operation));
  });

  bench("execute direct write", async () => {
    await sqliteClient.user.update({
      where: { id: "direct-write-user" },
      data: { age: { increment: 1 } },
    });
  });

  bench("execute non-RETURNING write", async () => {
    await nonReturningClient.user.update({
      where: { id: "non-returning-user" },
      data: { age: { increment: 1 } },
    });
  });

  bench("execute nested relation write", async () => {
    const id = nestedPostId++;
    await sqliteClient.user.update({
      where: { id: "nested-write-user" },
      data: {
        posts: {
          create: {
            id: `operation-program-post-${id}`,
            title: "Nested",
            published: false,
            views: 0,
          },
        },
      },
    });
  });
});
