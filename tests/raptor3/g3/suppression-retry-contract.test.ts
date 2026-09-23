import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { UniqueConstraintError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

class ScopeWitnessSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly controls: string[] = [];
  transactionCalls = 0;

  reset(): void {
    this.statements.length = 0;
    this.controls.length = 0;
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

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (
      /^(?:SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/.test(statement)
    )
      this.controls.push(statement);
    return super.executeRaw<T>(client, statement, parameters);
  }

  protected override async transaction<T>(
    client: Database.Database,
    execute: (transaction: Database.Database) => Promise<T>,
    context?: QueryExecutionContext
  ): Promise<T> {
    this.transactionCalls++;
    return super.transaction(client, execute, context);
  }
}

function suppressionSchema(onTitle: (value: string) => string) {
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("g3_scope_authors");
  const post = s
    .model({
      id: s.int().id(),
      title: s.string().schema(
        v.string({
          transform(value) {
            return onTitle(value);
          },
        })
      ),
      authorId: s.int(),
      author: s
        .toOne(() => author)
        .fields("authorId")
        .references("id"),
      notes: s.toMany(() => note),
    })
    .map("g3_scope_posts");
  const note = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      postId: s.int(),
      post: s
        .toOne(() => post)
        .fields("postId")
        .references("id"),
    })
    .map("g3_scope_notes");
  return { author, post, note };
}

async function createWorld(onTitle: (value: string) => string) {
  const schema = suppressionSchema(onTitle);
  const database = new Database(":memory:");
  const driver = new ScopeWitnessSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  const candidate = createCommandEngine({ schema, driver });
  driver.reset();
  return { candidate, client, database, driver };
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function candidateOperation(
  world: Awaited<ReturnType<typeof createWorld>>,
  model: "post",
  operation: "createMany" | "update",
  args: unknown
) {
  return overrideTransactionOperation(world.client.post.findMany(), {
    executeWith(transactionDriver) {
      return world.candidate.execute(model, operation, args, {
        kind: "borrowed-transaction",
        driver: transactionDriver,
        memberRollback: (execute, context) =>
          transactionDriver.withTransaction(execute, undefined, context),
      });
    },
  });
}

describe("G3 C09 transaction-owned suppression regions", () => {
  it("suppresses only one root subtree and lets a later array member observe the healthy suffix", async () => {
    let admissions = 0;
    const world = await createWorld((value) => {
      admissions++;
      return `${value}-admitted`;
    });
    try {
      const existingAuthor = await world.client.author.create({
        data: { name: "existing-author" },
      });
      await world.client.post.create({
        data: { id: 1, title: "kept", authorId: existingAuthor.id },
      });
      admissions = 0;
      world.driver.reset();

      const series = candidateOperation(world, "post", "createMany", {
        data: [
          {
            id: 2,
            title: "prefix",
            author: { create: { name: "prefix-author" } },
          },
          {
            id: 1,
            title: "duplicate",
            author: { create: { name: "ghost-author" } },
          },
          {
            id: 3,
            title: "suffix",
            author: { create: { name: "suffix-author" } },
          },
        ],
        skipDuplicates: true,
        select: { id: true, title: true },
      });
      const observer = candidateOperation(world, "post", "update", {
        where: { id: 3 },
        data: { title: "observed" },
        select: { id: true, title: true },
      });

      assert.deepEqual(
        await transactionArray(world.client, [series, observer]),
        [
          [
            { id: 2, title: "prefix-admitted" },
            { id: 3, title: "suffix-admitted" },
          ],
          { id: 3, title: "observed-admitted" },
        ]
      );
      assert.equal(admissions, 4, "each admitted title must transform once");
      assert.equal(world.driver.transactionCalls, 1);
      assert.equal(
        world.driver.controls.filter((sql) => sql.startsWith("SAVEPOINT "))
          .length,
        3
      );
      assert.equal(
        world.driver.controls.filter((sql) =>
          sql.startsWith("ROLLBACK TO SAVEPOINT ")
        ).length,
        1
      );
      assert.deepEqual(
        await world.client.author.findMany({
          orderBy: { name: "asc" },
          select: { name: true },
        }),
        [
          { name: "existing-author" },
          { name: "prefix-author" },
          { name: "suffix-author" },
        ]
      );
      assert.deepEqual(
        await world.client.post.findMany({
          orderBy: { id: "asc" },
          select: { id: true, title: true },
        }),
        [
          { id: 1, title: "kept-admitted" },
          { id: 2, title: "prefix-admitted" },
          { id: 3, title: "observed-admitted" },
        ]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("keeps a descendant unique failure fatal and rolls back an earlier array prefix", async () => {
    const world = await createWorld((value) => value);
    try {
      const existingAuthor = await world.client.author.create({
        data: { name: "existing-author" },
      });
      await world.client.post.create({
        data: {
          id: 10,
          title: "seed",
          authorId: existingAuthor.id,
          notes: { create: { id: "seed-note", slug: "taken" } },
        },
      });
      world.driver.reset();

      const series = candidateOperation(world, "post", "createMany", {
        data: [
          {
            id: 2,
            title: "prefix",
            author: { create: { name: "prefix-author" } },
            notes: { create: { id: "prefix-note", slug: "fresh" } },
          },
          {
            id: 3,
            title: "doomed",
            author: { create: { name: "ghost-author" } },
            notes: { create: { id: "doomed-note", slug: "taken" } },
          },
        ],
        skipDuplicates: true,
      });

      await assert.rejects(
        transactionArray(world.client, [series]),
        (failure) => failure instanceof UniqueConstraintError
      );
      assert.equal(world.driver.transactionCalls, 1);
      assert.deepEqual(
        await world.client.author.findMany({ select: { name: true } }),
        [{ name: "existing-author" }]
      );
      assert.deepEqual(
        await world.client.post.findMany({ select: { id: true } }),
        [{ id: 10 }]
      );
      assert.deepEqual(
        await world.client.note.findMany({ select: { id: true, slug: true } }),
        [{ id: "seed-note", slug: "taken" }]
      );
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });
});
