/**
 * G4-02 independent review — how many times the ENGINE's two public entries
 * admit, and whether a `_count` projection on a root delete takes the
 * locked-capture branch.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

let transforms = 0;

const note = s
  .model({
    id: s.int().id(),
    label: s.string().schema(
      v.string({
        transform(value) {
          transforms++;
          return value;
        },
      })
    ),
  })
  .map("rv2e_notes");

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("rv2e_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2e_posts");

const schema = { note, author, post };

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
  await client.author.create({ data: { id: 1, name: "Ada" } });
  await client.post.createMany({
    data: [
      { id: 10, title: "a", authorId: 1 },
      { id: 11, title: "b", authorId: 1 },
    ],
  });
  driver.reset();
  transforms = 0;
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, engine: createCommandEngine({ schema, driver }) };
}

describe("G4-02 review — admission count through the engine's public entries", () => {
  it("prepareBatch() then execute() on the engine admits the same payload twice", async () => {
    const w = await world();
    const args = { data: { id: 1, label: "once" } };
    await w.engine.prepareBatch("note", "create", args);
    await w.engine.execute("note", "create", args);
    // eslint-disable-next-line no-console
    console.log("ADMISSIONS engine entries", transforms);
    assert.equal(
      transforms,
      1,
      `admission must happen exactly once for one payload; saw ${transforms}`
    );
  });

  it("one prepared handle admits once across args/read/prepareBatch/execute", async () => {
    const w = await world();
    const prepared = w.engine.prepare("note", "create", {
      data: { id: 2, label: "twice" },
    });
    void prepared.args;
    await prepared.prepareBatch();
    await prepared.execute();
    // eslint-disable-next-line no-console
    console.log("ADMISSIONS one handle", transforms);
    assert.equal(transforms, 1);
  });
});

describe("G4-02 review — root delete projections", () => {
  it("a _count projection reads before the removal", async () => {
    const w = await world();
    w.driver.reset();
    const value = await w.engine.execute("author", "delete", {
      where: { id: 1 },
      select: { id: true, _count: { select: { posts: true } } },
    });
    const kinds = w.driver.statements.map((s) => s.match(/^\w+/)?.[0]);
    // eslint-disable-next-line no-console
    console.log("COUNTPROJ", JSON.stringify(value), JSON.stringify(kinds));
    assert.deepEqual(value, { id: 1, _count: { posts: 2 } });
    assert.equal(kinds.at(-1), "DELETE");
    assert.ok(
      kinds.length > 1,
      "a _count projection must be read before the row is removed"
    );
  });
});
