import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import {
  TransactionError,
  UniqueConstraintError,
  VibORMErrorCode,
} from "@errors";
import { getAdapterInternals } from "@adapters/adapter-internals";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, it } from "vitest";

const BORROWED_SUPPRESSION_REFUSAL =
  "Raptor 3 borrowed createMany skipDuplicates requires an operation-owned member rollback region.";

class ReviewSQLiteDriver extends SQLite3Driver {
  readonly statements: string[] = [];
  readonly controlStatements: string[] = [];
  transactionCalls = 0;

  resetObservations(): void {
    this.statements.length = 0;
    this.controlStatements.length = 0;
    this.transactionCalls = 0;
  }

  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    this.statements.push(statement);
    return super.execute<T>(client, statement, parameters);
  }

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (
      /^(?:SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/.test(statement)
    )
      this.controlStatements.push(statement);
    return super.executeRaw<T>(client, statement, parameters);
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

function assertRow(row: unknown): asserts row is Record<string, unknown> {
  assert(row !== null && typeof row === "object" && !Array.isArray(row));
}

function rows(value: unknown): Record<string, unknown>[] {
  assert(Array.isArray(value));
  return value.map((row) => {
    assertRow(row);
    return row;
  });
}

async function migratedWorld<S extends Record<string, AnyModel>>(
  schema: S,
  database: Database.Database
) {
  const driver = new ReviewSQLiteDriver({ client: database });
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.resetObservations();
  return {
    candidate: createCommandEngine({ schema, driver }),
    client,
    driver,
  };
}

async function closeWorld(world: { client: { $disconnect(): Promise<void> } }) {
  await world.client.$disconnect();
}

async function createChooseWorld() {
  const vault = s
    .model({
      id: s.string().id(),
      label: s.string(),
      gems: s.toMany(() => gem).through("review_choose_vault_gem"),
    })
    .map("review_choose_vaults");
  const gem = s
    .model({
      id: s.int().id(),
      tag: s.string().unique(),
      vaults: s.toMany(() => vault),
      facets: s.toMany(() => facet),
    })
    .map("review_choose_gems");
  const facet = s
    .model({
      id: s.string().id(),
      slug: s.string().unique(),
      gemId: s.int(),
      gem: s
        .toOne(() => gem)
        .fields("gemId")
        .references("id"),
    })
    .map("review_choose_facets");
  const database = new Database(":memory:");
  const world = await migratedWorld({ vault, gem, facet }, database);
  await world.client.vault.create({
    data: {
      id: "v1",
      label: "before",
      gems: { create: [{ id: 1, tag: "existing" }] },
    },
  });
  world.driver.resetObservations();
  return { database, world };
}

function statementVerbs(statements: readonly string[]): string[] {
  return statements.map((statement) => {
    const verb = statement.trim().split(/\s+/, 1)[0];
    assert(verb);
    return verb.toUpperCase();
  });
}

describe("G3P-04 review regressions", () => {
  it("refuses nested borrowed suppression before the parent scalar write", async () => {
    const vault = s
      .model({
        id: s.string().id(),
        label: s.string(),
        gems: s.toMany(() => gem).through("g3p04_review_vault_gem"),
      })
      .map("g3p04_review_vaults");
    const gem = s
      .model({
        id: s.int().id().increment(),
        tag: s.string().unique(),
        vaults: s.toMany(() => vault),
      })
      .map("g3p04_review_gems");
    const schema = { vault, gem };
    const database = new Database(":memory:");
    const world = await migratedWorld(schema, database);
    try {
      await world.client.vault.create({ data: { id: "v1", label: "before" } });
      world.driver.resetObservations();
      let caught: unknown;

      await world.driver.withTransaction(async (transactionDriver) => {
        try {
          await world.candidate.execute(
            "vault",
            "update",
            {
              where: { id: "v1" },
              data: {
                label: "leaked-after-refusal",
                gems: {
                  createMany: {
                    data: [{ tag: "never-inserted" }],
                    skipDuplicates: true,
                  },
                },
              },
            },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        } catch (error) {
          caught = error;
        }
      });

      assert(caught instanceof TransactionError);
      assert.equal(caught.code, VibORMErrorCode.TRANSACTION_FAILED);
      assert.equal(caught.message, BORROWED_SUPPRESSION_REFUSAL);
      assert.equal(
        world.driver.statements.length,
        0,
        "The capability refusal must precede the root UPDATE and every nested statement"
      );
      assert.equal(
        world.driver.transactionCalls,
        1,
        "Only the caller-owned transaction may own lifecycle"
      );
      assert.deepEqual(world.driver.controlStatements, []);
      assert.deepEqual(
        await world.client.vault.findMany({
          select: { id: true, label: true },
        }),
        [{ id: "v1", label: "before" }]
      );
      assert.deepEqual(await world.client.gem.findMany({}), []);
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("refuses found Choose-arm suppression before the parent scalar write", async () => {
    const { database, world } = await createChooseWorld();
    try {
      let caught: unknown;

      await world.driver.withTransaction(async (transactionDriver) => {
        try {
          await world.candidate.execute(
            "vault",
            "update",
            {
              where: { id: "v1" },
              data: {
                label: "leaked-through-choose",
                gems: {
                  upsert: {
                    where: { tag: "existing" },
                    create: { id: 2, tag: "missing-arm" },
                    update: {
                      facets: {
                        createMany: {
                          data: [{ id: "f1", slug: "never" }],
                          skipDuplicates: true,
                        },
                      },
                    },
                  },
                },
              },
            },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        } catch (error) {
          caught = error;
        }
      });

      const tape = statementVerbs(world.driver.statements);
      assert(caught instanceof TransactionError);
      assert.equal(caught.code, VibORMErrorCode.TRANSACTION_FAILED);
      assert.equal(caught.message, BORROWED_SUPPRESSION_REFUSAL);
      assert.deepEqual(
        { ...caught.meta },
        {
          driver: world.driver.driverName,
          model: "vault",
          operation: "update",
        }
      );
      assert.deepEqual(
        tape,
        [],
        "Found-arm capability refusal must precede every candidate statement"
      );
      assert.equal(world.driver.transactionCalls, 1);
      assert.deepEqual(world.driver.controlStatements, []);
      assert.deepEqual(
        await world.client.vault.findMany({
          select: { id: true, label: true },
        }),
        [{ id: "v1", label: "before" }]
      );
      assert.deepEqual(
        await world.client.gem.findMany({
          select: { id: true, tag: true },
        }),
        [{ id: 1, tag: "existing" }]
      );
      assert.deepEqual(await world.client.facet.findMany({}), []);
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("refuses missing Choose-arm suppression before the parent scalar write", async () => {
    const { database, world } = await createChooseWorld();
    try {
      let caught: unknown;

      await world.driver.withTransaction(async (transactionDriver) => {
        try {
          await world.candidate.execute(
            "vault",
            "update",
            {
              where: { id: "v1" },
              data: {
                label: "leaked-through-choose",
                gems: {
                  upsert: {
                    where: { tag: "absent" },
                    create: {
                      id: 2,
                      tag: "missing-arm",
                      facets: {
                        createMany: {
                          data: [{ id: "f1", slug: "never" }],
                          skipDuplicates: true,
                        },
                      },
                    },
                    update: { tag: "found-arm" },
                  },
                },
              },
            },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        } catch (error) {
          caught = error;
        }
      });

      const tape = statementVerbs(world.driver.statements);
      assert(caught instanceof TransactionError);
      assert.equal(caught.code, VibORMErrorCode.TRANSACTION_FAILED);
      assert.equal(caught.message, BORROWED_SUPPRESSION_REFUSAL);
      assert.deepEqual(
        { ...caught.meta },
        {
          driver: world.driver.driverName,
          model: "vault",
          operation: "update",
        }
      );
      assert.deepEqual(
        tape,
        [],
        "Missing-arm capability refusal must precede every candidate statement"
      );
      assert.equal(world.driver.transactionCalls, 1);
      assert.deepEqual(world.driver.controlStatements, []);
      assert.deepEqual(
        await world.client.vault.findMany({
          select: { id: true, label: true },
        }),
        [{ id: "v1", label: "before" }]
      );
      assert.deepEqual(
        await world.client.gem.findMany({
          select: { id: true, tag: true },
        }),
        [{ id: 1, tag: "existing" }]
      );
      assert.deepEqual(await world.client.facet.findMany({}), []);
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("preserves the exact borrowed INSERT failure without recovery replay", async () => {
    let admissions = 0;
    const user = s
      .model({
        id: s.int().id().increment(),
        email: s.string().unique(),
        label: s.string().schema(
          v.string({
            transform(value) {
              admissions++;
              return value;
            },
          })
        ),
      })
      .map("g3p04_review_users");
    const schema = { user };
    const database = new Database(":memory:");
    const world = await migratedWorld(schema, database);
    try {
      await world.client.user.create({
        data: { email: "race@example.test", label: "winner" },
      });
      admissions = 0;
      world.driver.resetObservations();
      const exactConstraint = getAdapterInternals(
        world.driver.adapter
      ).constraints.unique("g3p04_review_users", "email", [
        "email",
      ]).normalizedError;
      assert.deepEqual(exactConstraint, {
        columns: ["g3p04_review_users.email"],
      });
      const failure = new UniqueConstraintError("exact injected conflict", {
        cause: new Error("native duplicate"),
        meta: exactConstraint,
      });
      const tape: string[] = [];
      let caught: unknown;

      await world.driver.withTransaction(async (transactionDriver) => {
        const execute: typeof transactionDriver._execute =
          transactionDriver._execute.bind(transactionDriver);
        let hidWinner = false;
        transactionDriver._execute = async <T = Record<string, unknown>>(
          statement,
          context
        ): Promise<QueryResult<T>> => {
          const text = statement.strings.join("?").trim();
          const operation = text.split(/\s+/, 1)[0];
          assert(operation);
          tape.push(operation.toUpperCase());
          if (!hidWinner && /^SELECT\b/i.test(text)) {
            hidWinner = true;
            return { rows: [], rowCount: 0 };
          }
          if (/^INSERT\b/i.test(text)) throw failure;
          return execute<T>(statement, context);
        };
        try {
          await world.candidate.execute(
            "user",
            "upsert",
            {
              where: { email: "race@example.test" },
              create: { email: "race@example.test", label: "create" },
              update: { label: "updated" },
              select: { id: true, email: true, label: true },
            },
            { kind: "borrowed-transaction", driver: transactionDriver }
          );
        } catch (error) {
          caught = error;
        } finally {
          transactionDriver._execute = execute;
        }
      });

      assert.equal(
        caught,
        failure,
        "The exact provider failure identity must surface"
      );
      assert.deepEqual(
        tape,
        ["SELECT", "INSERT"],
        "Borrowed execution cannot reselect the winner, update it, or replay the operation"
      );
      assert.equal(
        admissions,
        2,
        "The create and update arms are admitted once each"
      );
      assert.equal(world.driver.transactionCalls, 1);
      assert.deepEqual(world.driver.controlStatements, []);
      assert.deepEqual(
        await world.client.user.findMany({
          select: { email: true, label: true },
        }),
        [{ email: "race@example.test", label: "winner" }]
      );
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("reads a static series selection after every member in input order", async () => {
    const author = s
      .model({
        id: s.int().id().increment(),
        name: s.string().unique(),
        posts: s.toMany(() => post),
      })
      .map("g3p04_review_authors");
    const post = s
      .model({
        id: s.int().id(),
        title: s.string(),
        authorId: s.int(),
        author: s
          .toOne(() => author)
          .fields("authorId")
          .references("id"),
      })
      .map("g3p04_review_posts");
    const schema = { author, post };
    const database = new Database(":memory:");
    const world = await migratedWorld(schema, database);
    try {
      await world.client.author.create({ data: { name: "original" } });

      const returned = rows(
        await world.candidate.execute("post", "createMany", {
          data: [
            {
              id: 1,
              title: "first",
              author: { connect: { name: "original" } },
            },
            {
              id: 2,
              title: "second",
              author: {
                create: {
                  name: "thief",
                  posts: { connect: { id: 1 } },
                },
              },
            },
          ],
          select: { id: true, title: true, authorId: true },
        })
      );
      const thieves = await world.client.author.findMany({
        where: { name: "thief" },
        select: { id: true },
      });
      assert.equal(thieves.length, 1);
      const thief = thieves[0];
      assert(thief);

      assert.deepEqual(returned, [
        { id: 1, title: "first", authorId: thief.id },
        { id: 2, title: "second", authorId: thief.id },
      ]);
      assert.deepEqual(
        await world.client.post.findMany({
          orderBy: { id: "asc" },
          select: { id: true, title: true, authorId: true },
        }),
        [
          { id: 1, title: "first", authorId: thief.id },
          { id: 2, title: "second", authorId: thief.id },
        ]
      );
    } finally {
      await closeWorld(world);
      database.close();
    }
  });
});
