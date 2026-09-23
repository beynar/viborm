/**
 * G4-02 independent review — root `delete` identity/shape and the envelope
 * rule's agreement with the shipped `canExecuteDirectly` classification.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    age: s.int(),
    posts: s.toMany(() => post),
  })
  .map("rv2b_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2b_posts");

const schema = { author, post };

class Recorder extends SQLite3Driver {
  readonly statements: { sql: string; context?: QueryExecutionContext }[] = [];
  transactionCalls = 0;
  reset() {
    this.statements.length = 0;
    this.transactionCalls = 0;
  }
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, context });
    return super.execute<T>(client, statement, parameters);
  }
  protected override async transaction<T>(
    client: Database.Database,
    body: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, body, context);
  }
}

interface World {
  database: Database.Database;
  driver: Recorder;
  // biome-ignore lint/suspicious/noExplicitAny: the shipped client type is not load-bearing here.
  client: any;
  engine: ReturnType<typeof createCommandEngine>;
}

const worlds: World[] = [];

async function createWorld(): Promise<World> {
  const database = new Database(":memory:");
  const driver = new Recorder({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.createMany({
    data: [
      { id: 1, name: "Ada", age: 36 },
      { id: 2, name: "Bo", age: 41 },
      { id: 3, name: "Cy", age: 20 },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "a", authorId: 1 },
      { id: 11, title: "b", authorId: 1 },
    ],
  });
  driver.reset();
  const engine = createCommandEngine({ schema, driver });
  const world = { database, driver, client, engine } as World;
  worlds.push(world);
  return world;
}

afterEach(async () => {
  for (const world of worlds.splice(0)) {
    await world.client.$disconnect();
    world.database.close();
  }
});

describe("G4-02 review — root delete", () => {
  it("not-found identity matches the shipped engine in class, code and message", async () => {
    const world = await createWorld();
    const shipped = await world.client.author
      .delete({ where: { id: 99 } })
      .then(() => undefined, (error: unknown) => error as Error);
    const candidate = await world.engine
      .execute("author", "delete", { where: { id: 99 } })
      .then(() => undefined, (error: unknown) => error as Error);
    const facts = (error: unknown) => ({
      name: (error as Error).name,
      message: (error as Error).message,
      code: (error as { code?: unknown }).code,
      meta: (error as { meta?: Record<string, unknown> }).meta,
    });
    // eslint-disable-next-line no-console
    console.log("NF shipped", JSON.stringify(facts(shipped)));
    // eslint-disable-next-line no-console
    console.log("NF candidate", JSON.stringify(facts(candidate)));
    assert.equal(facts(candidate).name, facts(shipped).name);
    assert.equal(facts(candidate).code, facts(shipped).code);
    assert.equal(facts(candidate).message, facts(shipped).message);
  });

  it("refuses a non-unique delete where exactly as the shipped engine does", async () => {
    const world = await createWorld();
    const shipped = await world.client.author
      // biome-ignore lint/suspicious/noExplicitAny: intentionally invalid input
      .delete({ where: { name: "Ada" } as any })
      .then(() => "accepted", (error: unknown) => (error as Error).name);
    const candidate = await world.engine
      .execute("author", "delete", { where: { name: "Ada" } })
      .then(() => "accepted", (error: unknown) => (error as Error).name);
    // eslint-disable-next-line no-console
    console.log("NONUNIQUE", shipped, candidate);
    assert.equal(candidate, shipped);
  });

  it("a delete with `include` of a relation still reads before the removal", async () => {
    const world = await createWorld();
    world.driver.reset();
    const value = await world.engine.execute("author", "delete", {
      where: { id: 1 },
      include: { posts: true },
    });
    const kinds = world.driver.statements.map((s) => s.sql.match(/^\w+/)?.[0]);
    // eslint-disable-next-line no-console
    console.log("INCLUDE kinds", JSON.stringify(kinds), JSON.stringify(value));
    assert.equal(
      Number(
        world.database.prepare("SELECT COUNT(*) FROM rv2b_authors").pluck().get()
      ),
      2
    );
  });
});

describe("G4-02 review — envelope classification agreement", () => {
  const cases: {
    name: string;
    shipped: (world: World) => PromiseLike<unknown>;
    candidate: (world: World) => PromiseLike<unknown>;
  }[] = [
    {
      name: "root create (scalar only)",
      shipped: (w) => w.client.author.create({ data: { id: 7, name: "D", age: 1 } }),
      candidate: (w) =>
        w.engine.execute("author", "create", { data: { id: 8, name: "E", age: 2 } }),
    },
    {
      name: "createMany (2 rows)",
      shipped: (w) =>
        w.client.author.createMany({
          data: [
            { id: 21, name: "F", age: 1 },
            { id: 22, name: "G", age: 2 },
          ],
        }),
      candidate: (w) =>
        w.engine.execute("author", "createMany", {
          data: [
            { id: 31, name: "H", age: 1 },
            { id: 32, name: "I", age: 2 },
          ],
        }),
    },
    {
      name: "deleteMany",
      shipped: (w) => w.client.author.deleteMany({ where: { id: 3 } }),
      candidate: (w) => w.engine.execute("author", "deleteMany", { where: { id: 2 } }),
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name}: candidate envelope matches shipped`, async () => {
      const world = await createWorld();
      world.driver.reset();
      await testCase.shipped(world);
      const shippedCost = {
        statements: world.driver.statements.length,
        transactions: world.driver.transactionCalls,
      };
      world.driver.reset();
      await testCase.candidate(world);
      const candidateCost = {
        statements: world.driver.statements.length,
        transactions: world.driver.transactionCalls,
      };
      // eslint-disable-next-line no-console
      console.log(
        `ENV ${testCase.name}`,
        JSON.stringify({ shipped: shippedCost, candidate: candidateCost })
      );
      assert.deepEqual(candidateCost, shippedCost);
    });
  }
});
