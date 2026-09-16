/**
 * G4-02 independent review — the published prepared-read facts, and the
 * relation-projection branch the unit changed for `deleteMany` only.
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
  .map("rv2d_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2d_posts");

const schema = { author, post };

class Recorder extends SQLite3Driver {
  readonly statements: string[] = [];
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
    this.statements.push(statement);
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

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

async function world() {
  const database = new Database(":memory:");
  const driver = new Recorder({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  if (!migration.applied) throw new Error("schema did not apply");
  await client.author.createMany({
    data: [
      { id: 1, name: "Ada", age: 36 },
      { id: 2, name: "Bo", age: 41 },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "a", authorId: 1 },
      { id: 11, title: "b", authorId: 1 },
      { id: 12, title: "c", authorId: 2 },
    ],
  });
  driver.reset();
  const engine = createCommandEngine({ schema, driver });
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, client, engine };
}

describe("G4-02 review — prepared read facts", () => {
  it("`read.single` disagrees with the value the read owner actually publishes", async () => {
    const w = await world();
    const rows: Record<string, unknown>[] = [];
    for (const [operation, args] of [
      ["findUnique", { where: { id: 1 } }],
      ["findFirst", {}],
      ["findMany", {}],
      ["count", {}],
      ["exist", {}],
      ["aggregate", { _count: true }],
      ["groupBy", { by: ["age"], _count: true }],
    ] as const) {
      const prepared = w.engine.prepare("author", operation, args);
      const value = await w.engine.execute("author", operation, args);
      rows.push({
        operation,
        single: prepared.read?.single,
        publishedIsRowLike:
          value !== null &&
          typeof value === "object" &&
          !Array.isArray(value),
        publishedType: Array.isArray(value) ? "array" : typeof value,
        shape: JSON.stringify(prepared.read?.shape),
      });
    }
    // eslint-disable-next-line no-console
    console.log("READFACTS", JSON.stringify(rows, undefined, 1));
    for (const row of rows) {
      assert.equal(
        row.single,
        row.publishedIsRowLike,
        `${row.operation}: read.single=${row.single} but the published value is a ${row.publishedType}`
      );
    }
  });

  it("prepare() admits once and answers the same Read for args, read and execute", async () => {
    const w = await world();
    const prepared = w.engine.prepare("author", "findMany", {
      where: { age: { gte: 0 } },
    });
    const first = prepared.args;
    const second = prepared.args;
    assert.equal(first, second, "admission is memoized");
    const readA = prepared.read;
    const readB = prepared.read;
    assert.deepEqual(readA, readB);
    const value = await prepared.execute();
    assert.equal((value as unknown[]).length, 2);
    // A second execute on the same handle must still work and must not re-admit.
    const again = await prepared.execute();
    assert.deepEqual(again, value);
  });
});

describe("G4-02 review — bulk relation projections", () => {
  it("deleteMany with a relation projection reads before removal and returns the rows", async () => {
    const w = await world();
    w.driver.reset();
    const value = await w.engine.execute("author", "deleteMany", {
      where: { id: { in: [1, 2] } },
      select: { id: true, posts: { orderBy: { id: "asc" }, select: { id: true } } },
    });
    // eslint-disable-next-line no-console
    console.log(
      "DELETEMANY",
      JSON.stringify(value),
      JSON.stringify(w.driver.statements.map((s) => s.match(/^\w+/)?.[0]))
    );
    assert.deepEqual(value, [
      { id: 1, posts: [{ id: 10 }, { id: 11 }] },
      { id: 2, posts: [{ id: 12 }] },
    ]);
  });

  it("updateMany with a relation projection keeps the correlated RETURNING the delete branch was fixed to avoid", async () => {
    const w = await world();
    w.driver.reset();
    let outcome: unknown;
    try {
      outcome = await w.engine.execute("author", "updateMany", {
        where: { id: { in: [1, 2] } },
        data: { age: { increment: 1 } },
        select: { id: true, posts: { orderBy: { id: "asc" }, select: { id: true } } },
      });
    } catch (error) {
      outcome = `${(error as Error).name}: ${(error as Error).message}`;
    }
    // eslint-disable-next-line no-console
    console.log(
      "UPDATEMANY",
      JSON.stringify(outcome),
      JSON.stringify({
        statements: w.driver.statements.length,
        transactions: w.driver.transactionCalls,
        kinds: w.driver.statements.map((s) => s.match(/^\w+/)?.[0]),
      })
    );
    assert.deepEqual(outcome, [
      { id: 1, posts: [{ id: 10 }, { id: 11 }] },
      { id: 2, posts: [{ id: 12 }] },
    ]);
  });
});
