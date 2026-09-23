/**
 * G4-02 independent review — B-4 statement context threading.
 *
 * The unit makes `statementContext()` answer the caller's trusted context for
 * EVERY statement. The V1 executor did not: `statementExecutionContext`
 * (src/query-engine/pattern/execute/values.ts:280 at e8114ed9, retired under
 * D-15) returned the operation's context only while the step's model equalled
 * the context's model, and otherwise called `deriveStatementExecutionContext`,
 * which minted a TRUSTED derived context carrying the nested model's name AND
 * the same resolved extension chain.
 *
 * This probe reads the per-statement `context.model` sequence a relation-bearing
 * root update produces on each engine.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createExecutionContext } from "@drivers/execution-context";
import type { ResolvedExtensionChain } from "@extensions/chain";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    posts: s.toMany(() => post),
  })
  .map("rv2c_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2c_posts");

const schema = { author, post };

class Recorder extends SQLite3Driver {
  readonly statements: { sql: string; context?: QueryExecutionContext }[] = [];
  reset() {
    this.statements.length = 0;
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
  await client.post.create({ data: { id: 10, title: "a", authorId: 1 } });
  driver.reset();
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, client };
}

const args = {
  where: { id: 1 },
  data: {
    name: "Ada II",
    posts: { update: { where: { id: 10 }, data: { title: "renamed" } } },
  },
};

function models(driver: Recorder) {
  return driver.statements.map((statement) => ({
    verb: statement.sql.match(/^\w+/)?.[0],
    model: statement.context?.model,
    operation: statement.context?.operation,
  }));
}

describe("G4-02 review — statement context", () => {
  it("the candidate reports the ROOT model for a nested-model statement where the shipped engine reports the nested one", async () => {
    const shippedWorld = await world();
    await shippedWorld.client.author.update(args);
    const shippedModels = models(shippedWorld.driver);

    const candidateWorld = await world();
    const chain = {
      extensions: [],
      hasCache: false,
      hasRequestHandlers: false,
      hasQueryHandlers: false,
      hasResultConsumers: false,
      request: {},
      query: {},
      statement: [],
      observe: [],
    } as unknown as ResolvedExtensionChain;
    const caller: QueryExecutionContext = createExecutionContext(
      { model: "author", operation: "update", correlationId: "rv2c" },
      undefined,
      () => "rv2c",
      chain
    );
    const engine = createCommandEngine({
      schema,
      driver: candidateWorld.driver,
    });
    await engine.execute("author", "update", args, undefined, caller);
    const candidateModels = models(candidateWorld.driver);

    // eslint-disable-next-line no-console
    console.log("CTX shipped", JSON.stringify(shippedModels));
    // eslint-disable-next-line no-console
    console.log("CTX candidate", JSON.stringify(candidateModels));

    const shippedNested = shippedModels.filter((row) => row.model === "post");
    const candidateNested = candidateModels.filter((row) => row.model === "post");
    assert.ok(
      shippedNested.length > 0,
      "the shipped engine attributes at least one statement to the nested model"
    );
    assert.ok(
      candidateNested.length > 0,
      "the candidate attributes no statement to the nested model: every statement carries the root model"
    );
  });
});
