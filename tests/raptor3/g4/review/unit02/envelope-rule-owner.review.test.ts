/**
 * G4-02 independent review — is the stated envelope rule the operative one?
 *
 * `OperationContext.run` states: "the envelope opens at the first statement
 * that is not the operation's only statement", enforced by a private
 * `requiresEnvelope` sentinel raised inside `dispatch` and recovered by
 * `restart()`. The DECISION, however, is `PhysicalPlan.single`, computed by six
 * per-verb boolean expressions in `Commands.plan`.
 *
 * This probe counts (a) how often the sentinel recovery actually runs across
 * every admitted verb shape, and (b) the statement/transaction cost of each
 * shape on both engines.
 */

import assert from "node:assert/strict";
import type { Operations } from "@client/types";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { OperationContext } from "@query-engine/raptor3/shared/operation-context";
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
  .map("rv2g_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2g_posts");

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
      { id: 3, name: "Cy", age: 20 },
      { id: 4, name: "Di", age: 50 },
    ],
  });
  await client.post.createMany({
    data: [
      { id: 10, title: "a", authorId: 1 },
      { id: 11, title: "b", authorId: 1 },
    ],
  });
  driver.reset();
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, engine: createCommandEngine({ schema, driver }) };
}

type Shape = readonly [string, string, string, Record<string, unknown>];

const shapes: readonly Shape[] = [
  ["findUnique", "author", "findUnique", { where: { id: 1 } }],
  ["findMany+include", "author", "findMany", { include: { posts: true } }],
  ["count", "author", "count", {}],
  ["aggregate", "author", "aggregate", { _count: true }],
  ["groupBy", "author", "groupBy", { by: ["age"], _count: true }],
  ["create scalar", "author", "create", { data: { id: 20, name: "E", age: 1 } }],
  [
    "createMany 1 row",
    "author",
    "createMany",
    { data: [{ id: 21, name: "F", age: 1 }] },
  ],
  [
    "createMany 2 rows",
    "author",
    "createMany",
    {
      data: [
        { id: 22, name: "G", age: 1 },
        { id: 23, name: "H", age: 2 },
      ],
    },
  ],
  [
    "createMany 2 rows + select",
    "author",
    "createMany",
    {
      data: [
        { id: 24, name: "I", age: 1 },
        { id: 25, name: "J", age: 2 },
      ],
      select: { id: true },
    },
  ],
  [
    "update fold",
    "author",
    "update",
    { where: { id: 1 }, data: { age: { increment: 1 } } },
  ],
  [
    "update relation projection",
    "author",
    "update",
    {
      where: { id: 1 },
      data: { age: { increment: 1 } },
      select: { id: true, posts: { select: { id: true } } },
    },
  ],
  [
    "updateMany no select",
    "author",
    "updateMany",
    { where: { age: { gte: 0 } }, data: { age: { increment: 1 } } },
  ],
  [
    "updateMany + select",
    "author",
    "updateMany",
    {
      where: { age: { gte: 0 } },
      data: { age: { increment: 1 } },
      select: { id: true },
    },
  ],
  [
    "updateMany limit",
    "author",
    "updateMany",
    { where: { age: { gte: 0 } }, data: { age: { increment: 1 } }, limit: 2 },
  ],
  ["delete scalar", "author", "delete", { where: { id: 4 } }],
  [
    "delete relation projection",
    "author",
    "delete",
    { where: { id: 3 }, select: { id: true, posts: { select: { id: true } } } },
  ],
  ["deleteMany no select", "post", "deleteMany", { where: { id: 11 } }],
  [
    "deleteMany + select",
    "post",
    "deleteMany",
    { where: { id: 10 }, select: { id: true } },
  ],
  [
    "upsert missing",
    "author",
    "upsert",
    {
      where: { id: 30 },
      create: { id: 30, name: "K", age: 1 },
      update: { age: { increment: 1 } },
    },
  ],
];

describe("G4-02 review — the envelope rule's real owner", () => {
  it("the sentinel recovery never runs, and `single` is not `one statement`", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: private-method instrumentation
    const proto = OperationContext.prototype as any;
    const original = proto.restart;
    let restarts = 0;
    proto.restart = function patched(this: unknown, ...rest: unknown[]) {
      restarts++;
      return original.apply(this, rest);
    };
    const table: Record<string, unknown>[] = [];
    try {
      for (const [name, model, operation, args] of shapes) {
        const w = await world();
        w.driver.reset();
        let outcome = "ok";
        try {
          await w.engine.execute(model, operation as Operations, args);
        } catch (error) {
          outcome = (error as Error).name;
        }
        table.push({
          shape: name,
          statements: w.driver.statements.length,
          transactions: w.driver.transactionCalls,
          outcome,
        });
      }
    } finally {
      proto.restart = original;
    }
    // eslint-disable-next-line no-console
    console.log("ENVTABLE", JSON.stringify(table));
    // eslint-disable-next-line no-console
    console.log("RESTARTS", restarts);

    const oneStatementWithEnvelope = table.filter(
      (row) => row.statements === 1 && (row.transactions as number) > 0
    );
    assert.deepEqual(
      oneStatementWithEnvelope,
      [],
      "an operation that issues one statement must show no BEGIN/COMMIT (note §5, falsifier D-a)"
    );
    assert.equal(
      restarts,
      0,
      "the sentinel recovery never runs for any admitted verb shape"
    );
  });
});
