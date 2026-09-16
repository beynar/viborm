/**
 * G4-03b review-followup probe — the SCOPE of divergence D-6.
 *
 * Repair 3 records D-6 (`unit03/note.md` FU.6) with the scope claim "`upsert`
 * is the ONLY diverging verb", carried from this reviewer's all-verb sweep
 * (`route-seams.review.test.ts`). That sweep published ONE argument shape per
 * verb, and every shape was FLAT (scalars only, including a defaulted scalar).
 *
 * This probe widens the untested dimension: a NESTED relation payload on the
 * two write verbs that accept one, and a read whose payload carries a nested
 * `include`/`where`. If any of them diverges, the D-6 scope sentence and the
 * LX-12 row's "every verb but `upsert` publishes the same admitted payload"
 * are both overstated.
 */

import assert from "node:assert/strict";
import { VibORM, type VibORMClient } from "@client/client";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCandidateRoute } from "@query-engine/raptor3/route/client-route";
import { s } from "@schema";
import { createClient } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, test } from "vitest";

const author = s
  .model({
    id: s.int().id().increment(),
    email: s.string().unique(),
    name: s.string(),
    rank: s.int().default(0),
    books: s.toMany(() => book),
  })
  .map("g4r3b_nested_authors");

const book = s
  .model({
    id: s.int().id().increment(),
    title: s.string().unique(),
    authorId: s.int(),
    author: s
      .toOne(() => author)
      .fields("authorId")
      .references("id"),
  })
  .map("g4r3b_nested_books");

const schema = { author, book };

type WorldClient = VibORMClient<{
  driver: SQLite3Driver;
  schema: typeof schema;
}>;

const closers: (() => Promise<void>)[] = [];

async function createWorld(route: "shipped" | "candidate") {
  const database = new Database(":memory:");
  const driver = new SQLite3Driver({ client: database });
  const config = { driver, schema };
  const client = (
    route === "shipped"
      ? createClient(config)
      : VibORM.create(config, createCandidateRoute)
  ) as WorldClient;
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { client, database };
}

afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

function applyUnsafe<T extends object>(client: T, definition: unknown): T {
  const extend = Reflect.get(client, "$extends") as CallableFunction;
  return Reflect.apply(extend, client, [definition]) as T;
}

interface Published {
  readonly label: string;
  readonly input: unknown;
}

async function observe(route: "shipped" | "candidate") {
  const world = await createWorld(route);
  const seen: Published[] = [];
  const witness = (label: string) => ({
    async [label]({
      input,
      proceed,
    }: {
      input: unknown;
      proceed: () => Promise<unknown>;
    }) {
      seen.push({ input: structuredClone(input), label });
      return proceed();
    },
  });
  const client = applyUnsafe(world.client, {
    name: "nested-payload-witness",
    query: {
      author: {
        ...witness("create"),
        ...witness("findMany"),
        ...witness("update"),
      },
    },
  });

  const outcomes: string[] = [];
  const run = async (label: string, call: () => PromiseLike<unknown>) => {
    try {
      outcomes.push(`${label}=${JSON.stringify(await call())}`);
    } catch (error) {
      outcomes.push(`${label}!${(error as Error).constructor.name}`);
    }
  };

  // 1. a nested relation WRITE inside `create`
  await run("create", () =>
    client.author.create({
      data: {
        books: { create: [{ title: "n-1" }, { title: "n-2" }] },
        email: "nested@example.test",
        name: "Nested",
      },
      select: { email: true },
    })
  );
  // 2. a nested relation WRITE inside `update`, beside a scalar assignment
  await run("update", () =>
    client.author.update({
      data: {
        books: { create: [{ title: "n-3" }] },
        name: "Renamed",
      },
      select: { name: true },
      where: { email: "nested@example.test" },
    })
  );
  // 3. a READ whose payload carries a nested include, where and orderBy
  await run("findMany", () =>
    client.author.findMany({
      include: {
        books: {
          orderBy: { title: "asc" },
          where: { title: { contains: "n" } },
        },
      },
      where: { books: { some: { title: { startsWith: "n-" } } } },
    })
  );

  return { outcomes, seen };
}

describe("G4-03b review-followup — D-6 scope: nested payloads", () => {
  test("a nested relation payload publishes the same interceptor input on both routes", async () => {
    const shipped = await observe("shipped");
    const candidate = await observe("candidate");

    // The public answers first: this probe is about the PUBLISHED payload only.
    assert.deepEqual(candidate.outcomes, shipped.outcomes);
    assert.deepEqual(
      candidate.seen.map(({ label }) => label),
      ["create", "update", "findMany"]
    );
    // Non-vacuity: every call SUCCEEDED (an `!` marks a thrown error), and the
    // published payloads really carry the nested arms this probe is about.
    assert.deepEqual(candidate.outcomes, [
      'create={"email":"nested@example.test"}',
      'update={"name":"Renamed"}',
      'findMany=[{"id":1,"email":"nested@example.test","name":"Renamed","rank":0,"books":[{"id":1,"title":"n-1","authorId":1},{"id":2,"title":"n-2","authorId":1},{"id":3,"title":"n-3","authorId":1}]}]',
    ]);
    const publishedData = (entry: Published) =>
      (entry.input as { data?: { books?: unknown } }).data?.books;
    assert.notEqual(publishedData(candidate.seen[0]!), undefined);
    assert.notEqual(publishedData(candidate.seen[1]!), undefined);

    assert.deepEqual(
      candidate.seen,
      shipped.seen,
      "a verb other than `upsert` publishes a different payload on the candidate route"
    );
  });
});
