/**
 * G4-02 independent review, repair round — how far the B-4 model-parity repair
 * reaches (review finding 2).
 *
 * The repair threads a per-statement model through `statementContext` and five
 * `read()` sites. The round-1 probe measured ONE shape (a relation-bearing root
 * update). These cells walk more nested shapes and report, per shape, the
 * per-statement `context.model` MULTISET on each engine — the thing an
 * instrumentation observer or statement transform actually sees.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { createExecutionContext } from "@drivers/execution-context";
import { SQLite3Driver } from "@drivers/sqlite3";
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
  .map("rv2s_authors");

const post = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s.toOne(() => author).fields("authorId").references("id"),
  })
  .map("rv2s_posts");

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
  await client.author.create({ data: { id: 2, name: "Bo" } });
  await client.post.create({ data: { id: 10, title: "a", authorId: 1 } });
  await client.post.create({ data: { id: 11, title: "b", authorId: 1 } });
  driver.reset();
  closers.push(async () => {
    await client.$disconnect();
    database.close();
  });
  return { database, driver, client };
}

function tally(driver: Recorder): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const statement of driver.statements) {
    const key = String(statement.context?.model);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function caller(): QueryExecutionContext {
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
  return createExecutionContext(
    { model: "author", operation: "update", correlationId: "rv2s" },
    undefined,
    () => "rv2s",
    chain
  );
}

const shapes = [
  [
    "nested update",
    "update",
    {
      where: { id: 1 },
      data: {
        name: "Ada II",
        posts: { update: { where: { id: 10 }, data: { title: "renamed" } } },
      },
    },
  ],
  [
    "nested create",
    "update",
    {
      where: { id: 1 },
      data: { posts: { create: { id: 30, title: "new" } } },
    },
  ],
  [
    "nested connect",
    "update",
    { where: { id: 2 }, data: { posts: { connect: { id: 11 } } } },
  ],
  [
    "nested delete",
    "update",
    { where: { id: 1 }, data: { posts: { delete: { id: 10 } } } },
  ],
  [
    "nested upsert",
    "update",
    {
      where: { id: 1 },
      data: {
        posts: {
          upsert: {
            where: { id: 40 },
            create: { id: 40, title: "u" },
            update: { title: "u2" },
          },
        },
      },
    },
  ],
  [
    "relation-bearing create",
    "create",
    { data: { id: 50, name: "Cy", posts: { create: { id: 51, title: "c" } } } },
  ],
] as const;

describe("G4-02 review (repair) — per-statement model attribution parity", () => {
  it("reports the candidate and shipped per-statement model tally for nested shapes", async () => {
    const report: Record<string, unknown>[] = [];
    const divergent: string[] = [];
    for (const [label, operation, args] of shapes) {
      const shippedWorld = await world();
      // biome-ignore lint/suspicious/noExplicitAny: the verb varies per shape.
      await (shippedWorld.client.author as any)[operation](args);
      const shippedTally = tally(shippedWorld.driver);

      const candidateWorld = await world();
      const engine = createCommandEngine({
        schema,
        driver: candidateWorld.driver,
      });
      let candidateTally: Record<string, number> | string;
      try {
        await engine.execute("author", operation, args, undefined, caller());
        candidateTally = tally(candidateWorld.driver);
      } catch (error) {
        candidateTally = `REFUSED ${(error as Error).name}`;
      }
      report.push({ label, shipped: shippedTally, candidate: candidateTally });
      if (
        typeof candidateTally !== "string" &&
        JSON.stringify(Object.keys(candidateTally).sort()) !==
          JSON.stringify(Object.keys(shippedTally).sort())
      )
        divergent.push(
          `${label}: shipped attributes ${JSON.stringify(
            shippedTally
          )} but the candidate attributes ${JSON.stringify(candidateTally)}`
        );
    }
    // eslint-disable-next-line no-console
    console.log("MODELTALLY", JSON.stringify(report, undefined, 1));
    assert.deepEqual(divergent, []);
  });
});
