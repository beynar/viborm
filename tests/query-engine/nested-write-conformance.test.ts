import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import type { BatchQuery, QueryResult } from "@drivers/types";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    posts: s.oneToMany(() => post),
  })
  .map("conformance_users");

const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    authorId: s.string().nullable(),
    author: s
      .manyToOne(() => user)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("conformance_posts");

const schema = { user, post };

class BatchOnlyPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

function makeClient(driver: PGliteDriver) {
  return createClient({ schema, driver });
}

type ConformanceClient = ReturnType<typeof makeClient>;

async function dumpState(client: ConformanceClient) {
  const [users, posts] = await Promise.all([
    client.user.findMany({ orderBy: { id: "asc" } }),
    client.post.findMany({ orderBy: { id: "asc" } }),
  ]);
  return { users, posts };
}

type PersistedState = Awaited<ReturnType<typeof dumpState>>;

interface Scenario {
  name: string;
  seed?: (client: ConformanceClient) => PromiseLike<unknown>;
  act: (client: ConformanceClient) => PromiseLike<unknown>;
  expected: PersistedState;
}

const scenarios: Scenario[] = [
  {
    name: "update with nested create on FK-holding parent links the parent",
    seed: (client) =>
      client.post.create({
        data: { id: "post-1", title: "Orphan", authorId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "post-1" },
        data: {
          title: "Changed",
          author: { create: { id: "user-1", name: "Alice" } },
        },
      }),
    expected: {
      users: [{ id: "user-1", name: "Alice" }],
      posts: [{ id: "post-1", title: "Changed", authorId: "user-1" }],
    },
  },
  {
    name: "update with nested connectOrCreate on FK-holding parent connects an existing target",
    seed: async (client) => {
      await client.user.create({ data: { id: "user-1", name: "Existing" } });
      await client.post.create({
        data: { id: "post-1", title: "Orphan", authorId: null },
      });
    },
    act: (client) =>
      client.post.update({
        where: { id: "post-1" },
        data: {
          author: {
            connectOrCreate: {
              where: { id: "user-1" },
              create: { id: "user-1", name: "Should not create" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "user-1", name: "Existing" }],
      posts: [{ id: "post-1", title: "Orphan", authorId: "user-1" }],
    },
  },
  {
    name: "update with nested connectOrCreate on FK-holding parent creates a missing target",
    seed: (client) =>
      client.post.create({
        data: { id: "post-1", title: "Orphan", authorId: null },
      }),
    act: (client) =>
      client.post.update({
        where: { id: "post-1" },
        data: {
          author: {
            connectOrCreate: {
              where: { id: "user-1" },
              create: { id: "user-1", name: "Created" },
            },
          },
        },
      }),
    expected: {
      users: [{ id: "user-1", name: "Created" }],
      posts: [{ id: "post-1", title: "Orphan", authorId: "user-1" }],
    },
  },
  {
    name: "update with nested create on inverse relation links the child",
    seed: (client) =>
      client.user.create({ data: { id: "user-1", name: "Alice" } }),
    act: (client) =>
      client.user.update({
        where: { id: "user-1" },
        data: { posts: { create: { id: "post-1", title: "Created" } } },
      }),
    expected: {
      users: [{ id: "user-1", name: "Alice" }],
      posts: [{ id: "post-1", title: "Created", authorId: "user-1" }],
    },
  },
];

async function runScenario(
  scenario: Scenario,
  createDriver: (db: PGlite) => PGliteDriver
): Promise<PersistedState> {
  const db = new PGlite();
  const setupClient = makeClient(new PGliteDriver({ client: db }));
  await push(setupClient, { force: true });

  const client = makeClient(createDriver(db));
  try {
    await scenario.seed?.(client);
    await scenario.act(client);
    return await dumpState(client);
  } finally {
    await client.$disconnect();
  }
}

describe("nested-write conformance: transaction vs batch engines", () => {
  for (const scenario of scenarios) {
    // Each scenario boots two PGlite instances; well over the default 5s
    // timeout when the full suite runs in parallel.
    test(scenario.name, { timeout: 30_000 }, async () => {
      const transactionState = await runScenario(
        scenario,
        (db) => new PGliteDriver({ client: db })
      );
      const batchState = await runScenario(
        scenario,
        (db) => new BatchOnlyPGliteDriver({ client: db })
      );

      expect(transactionState).toEqual(scenario.expected);
      expect(batchState).toEqual(scenario.expected);
    });
  }
});
