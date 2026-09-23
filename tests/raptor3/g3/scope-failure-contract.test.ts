import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { readSuppressedFailures } from "@drivers/shared/suppressed-failure";
import { TransactionError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { overrideTransactionOperation } from "@tests/fixtures/transaction-operation";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

interface Deferred {
  readonly promise: Promise<void>;
  resolve(): void;
}

function deferred(): Deferred {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (!resolvePromise) throw new Error("Deferred resolver is unavailable");
      resolvePromise();
    },
  };
}

interface HeldInsert {
  readonly started: Promise<void>;
  release(): void;
  statementIndex(): number;
}

interface HeldInsertState {
  readonly started: Deferred;
  readonly released: Deferred;
  statementIndex: number | undefined;
}

class ScopeFailureSQLiteDriver extends SQLite3Driver {
  readonly statements: Array<{
    readonly context: QueryExecutionContext | undefined;
    readonly sql: string;
  }> = [];
  private heldInsert: HeldInsertState | undefined;

  holdNextInsert(): HeldInsert {
    if (this.heldInsert) throw new Error("An INSERT is already held");
    const started = deferred();
    const released = deferred();
    const held: HeldInsertState = {
      started,
      released,
      statementIndex: undefined,
    };
    this.heldInsert = held;
    return {
      started: started.promise,
      release: () => released.resolve(),
      statementIndex() {
        if (held.statementIndex === undefined)
          throw new Error("Held INSERT has not started");
        return held.statementIndex;
      },
    };
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push({ sql: statement, context });
    const held = this.heldInsert;
    if (held && statement.startsWith("INSERT INTO ")) {
      this.heldInsert = undefined;
      held.statementIndex = this.statements.length - 1;
      held.started.resolve();
      await held.released.promise;
    }
    return super.execute<T>(client, statement, parameters);
  }
}

function scopeSchema(onTitle: (title: string) => string) {
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("g3_failed_scope_authors");
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
    })
    .map("g3_failed_scope_posts");
  return { author, post };
}

async function createWorld(onTitle: (title: string) => string) {
  const schema = scopeSchema(onTitle);
  const database = new Database(":memory:");
  const driver = new ScopeFailureSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  const candidate = createCommandEngine({ schema, driver });
  driver.statements.length = 0;
  return { candidate, client, database, driver };
}

type World = Awaited<ReturnType<typeof createWorld>>;

const selected: true = true;

function seriesArgs(prefix: string, firstId: number) {
  return {
    data: [
      {
        id: firstId,
        title: `${prefix}-first`,
        author: { create: { name: `${prefix}-first-author` } },
      },
      {
        id: firstId + 1,
        title: `${prefix}-second`,
        author: { create: { name: `${prefix}-second-author` } },
      },
    ],
    select: { id: selected, title: selected },
  };
}

type Settled<T> =
  | { readonly status: "fulfilled"; readonly value: T }
  | { readonly reason: unknown; readonly status: "rejected" };

function settle<T>(promise: PromiseLike<T>): Promise<Settled<T>> {
  return Promise.resolve(promise).then(
    (value) => ({ status: "fulfilled", value }),
    (reason: unknown) => ({ status: "rejected", reason })
  );
}

function transactionArray(
  client: object,
  operations: readonly unknown[]
): Promise<unknown[]> {
  const transaction = Reflect.get(client, "$transaction");
  assert.equal(typeof transaction, "function");
  return Reflect.apply(transaction, client, [operations]);
}

function progressOf(failure: unknown): unknown {
  if (failure === null || typeof failure !== "object") return undefined;
  const meta = Reflect.get(failure, "meta");
  if (meta === null || typeof meta !== "object") return undefined;
  return Reflect.get(meta, "recordSeriesProgress");
}

function candidateSeriesOperation(
  world: World,
  source: PromiseLike<unknown>,
  args: ReturnType<typeof seriesArgs>
) {
  return overrideTransactionOperation(source, {
    executeWith(transactionDriver) {
      return world.candidate.execute("post", "createMany", args, {
        kind: "borrowed-transaction",
        driver: transactionDriver,
        memberRollback: (execute, context) =>
          transactionDriver.withTransaction(execute, undefined, context),
      });
    },
  });
}

function storedPosts(database: Database.Database) {
  return database
    .prepare("SELECT id,title,authorId FROM g3_failed_scope_posts ORDER BY id")
    .all();
}

function storedAuthors(database: Database.Database) {
  return database
    .prepare("SELECT id,name FROM g3_failed_scope_authors ORDER BY id")
    .all();
}

describe("G3 failed caller-scope publication", () => {
  // Independent oracles: plan §2.2 owns discarded-attempt settlement and
  // successor exclusion; the shipped driver scope scheduler owns close/drain;
  // the public nested-array contract owns caller rollback; G2.7 owns borrowed
  // driver identity. This file adds only the missing relation-series placement.
  it("rejects a late relation-series completion before public array success, progress, or a successor", async () => {
    const world = await createWorld((title) => title);
    const args = seriesArgs("array", 101);
    const held = world.driver.holdNextInsert();
    const launched = deferred();
    const callerFailure = new Error("enclosing callback failed");
    let arrayOutcome: Promise<Settled<unknown[]>> | undefined;
    try {
      const outerOutcome = settle(
        world.client.$transaction(async (transactionClient) => {
          const candidate = candidateSeriesOperation(
            world,
            transactionClient.post.findMany(),
            args
          );
          const array = transactionArray(transactionClient, [
            candidate,
            transactionClient.author.findMany(),
          ]);
          arrayOutcome = settle(array);
          launched.resolve();
          await held.started;
          throw callerFailure;
        })
      );

      // The callback registered its continuation on `started` before exposing
      // `launched`; promise reaction order therefore closes the caller scope
      // before this continuation releases the provider completion.
      await launched.promise;
      await held.started;
      held.release();

      const outer = await outerOutcome;
      assert.equal(outer.status, "rejected");
      if (outer.status !== "rejected") throw new Error("Expected rejection");
      assert.equal(outer.reason, callerFailure);
      if (!arrayOutcome) throw new Error("Array operation was not captured");
      const inner = await arrayOutcome;
      assert.equal(inner.status, "rejected");
      if (inner.status !== "rejected") throw new Error("Expected rejection");
      assert(inner.reason instanceof TransactionError);
      assert.equal(progressOf(inner.reason), undefined);

      const heldIndex = held.statementIndex();
      assert.equal(world.driver.statements.length, heldIndex + 1);
      const heldStatement = world.driver.statements[heldIndex];
      assert(heldStatement);
      assert.equal(heldStatement.context?.operation, "create");
      assert.match(heldStatement.sql, /g3_failed_scope_authors/);
      assert.deepEqual(storedAuthors(world.database), []);
      assert.deepEqual(storedPosts(world.database), []);
    } finally {
      held.release();
      await world.client.$disconnect();
      world.database.close();
    }
  });

  it("stops after two caller-plus-late failures, then admits one healthy suffix on the same engine", async () => {
    let admissions = 0;
    const world = await createWorld((title) => {
      admissions++;
      return `${title}-admitted`;
    });
    try {
      for (const { prefix, firstId } of [
        { prefix: "failed-a", firstId: 201 },
        { prefix: "failed-b", firstId: 301 },
      ]) {
        const args = seriesArgs(prefix, firstId);
        const held = world.driver.holdNextInsert();
        const launched = deferred();
        const callerFailure = new Error(`${prefix} caller failed`);
        let candidateOutcome: Promise<Settled<unknown>> | undefined;
        const statementStart = world.driver.statements.length;
        const scopeOutcome = settle(
          world.driver.withTransaction(async (transactionDriver) => {
            candidateOutcome = settle(
              world.candidate.execute("post", "createMany", args, {
                kind: "borrowed-transaction",
                driver: transactionDriver,
              })
            );
            launched.resolve();
            await held.started;
            throw callerFailure;
          })
        );

        await launched.promise;
        await held.started;
        held.release();

        if (!candidateOutcome)
          throw new Error("Candidate operation was not captured");
        const candidate = await candidateOutcome;
        assert.equal(candidate.status, "rejected");
        if (candidate.status !== "rejected")
          throw new Error("Expected rejection");
        assert(candidate.reason instanceof TransactionError);
        assert.equal(progressOf(candidate.reason), undefined);
        const scope = await scopeOutcome;
        assert.equal(scope.status, "rejected");
        if (scope.status !== "rejected") throw new Error("Expected rejection");
        assert.equal(scope.reason, callerFailure);
        assert.deepEqual(readSuppressedFailures(scope.reason), []);
        const heldIndex = held.statementIndex();
        assert.equal(heldIndex >= statementStart, true);
        assert.equal(world.driver.statements.length, heldIndex + 1);
        assert.deepEqual(storedAuthors(world.database), []);
        assert.deepEqual(storedPosts(world.database), []);
      }

      const healthyArgs = seriesArgs("healthy", 401);
      assert.deepEqual(
        await world.candidate.execute("post", "createMany", healthyArgs),
        [
          { id: 401, title: "healthy-first-admitted" },
          { id: 402, title: "healthy-second-admitted" },
        ]
      );
      assert.equal(admissions, 6);
      assert.deepEqual(storedAuthors(world.database), [
        { id: 1, name: "healthy-first-author" },
        { id: 2, name: "healthy-second-author" },
      ]);
      assert.deepEqual(storedPosts(world.database), [
        { id: 401, title: "healthy-first-admitted", authorId: 1 },
        { id: 402, title: "healthy-second-admitted", authorId: 2 },
      ]);
    } finally {
      await world.client.$disconnect();
      world.database.close();
    }
  });
});
