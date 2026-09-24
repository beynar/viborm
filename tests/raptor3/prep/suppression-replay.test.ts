import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { SQLite3Driver } from "@drivers/sqlite3";
import { ForeignKeyError, QueryError, UniqueConstraintError } from "@errors";
import { instrumentation } from "@instrumentation/extension";
import type { LogEvent } from "@instrumentation/types";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import v from "@validation/primitives/v";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

class WitnessSQLiteDriver extends SQLite3Driver {
  readonly statements: { sql: string; context?: QueryExecutionContext }[] = [];
  readonly controlStatements: string[] = [];
  transactionCalls = 0;
  failAfterSavepointRollback?: Error;

  resetObservations(): void {
    this.statements.length = 0;
    this.controlStatements.length = 0;
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

  protected override async executeRaw<T>(
    client: Database.Database,
    statement: string,
    parameters?: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const isSavepointRollback = statement.startsWith("ROLLBACK TO SAVEPOINT ");
    if (
      /^(?:SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)\b/.test(statement)
    )
      this.controlStatements.push(statement);
    const result = await super.executeRaw<T>(client, statement, parameters);
    if (isSavepointRollback && this.failAfterSavepointRollback) {
      const failure = this.failAfterSavepointRollback;
      this.failAfterSavepointRollback = undefined;
      throw failure;
    }
    return result;
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

class BatchOnlySQLiteDriver extends WitnessSQLiteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;
  beforeFirstBatch?: () => void;

  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls++;
    if (this.batchCalls === 1) this.beforeFirstBatch?.();
    return this.transaction(client, (transaction) =>
      super.executeBatch<T>(transaction, queries)
    );
  }
}

function rootSeriesSchema(
  onTitle: (value: string) => string = (value) => value
) {
  const author = s
    .model({
      id: s.int().id().increment(),
      name: s.string().unique(),
      posts: s.toMany(() => post),
    })
    .map("g3p04_root_authors");
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
    .map("g3p04_root_posts");
  return { author, post };
}

function junctionSeriesSchema() {
  const vault = s
    .model({
      id: s.string().id(),
      gems: s.toMany(() => gem).through("g3p04_vault_gem"),
    })
    .map("g3p04_vaults");
  const holder = s
    .model({
      id: s.string().id(),
      gems: s.toMany(() => gem),
    })
    .map("g3p04_holders");
  const gem = s
    .model({
      id: s.int().id().increment(),
      tag: s.string().unique(),
      holderId: s.string().nullable(),
      holder: s
        .toOne(() => holder)
        .fields("holderId")
        .references("id"),
      facets: s.toMany(() => facet),
      vaults: s.toMany(() => vault),
    })
    .map("g3p04_gems");
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
    .map("g3p04_facets");
  return { vault, holder, gem, facet };
}

async function migratedWorld<
  S extends Record<string, AnyModel>,
  D extends WitnessSQLiteDriver,
>(schema: S, driver: D) {
  const client = createClient({ schema, driver });
  const migration = await syncLiveSchema(client);
  assert.equal(migration.applied, true);
  driver.resetObservations();
  return { client, driver, candidate: createCommandEngine({ schema, driver }) };
}

async function closeWorld(world: {
  client: { $disconnect(): Promise<void> };
  driver: WitnessSQLiteDriver;
}) {
  await world.client.$disconnect();
}

describe("G3P-04 exact suppression and replay scopes", () => {
  it("suppresses one root and its prerequisite while preserving suffix, count, order and reentry state", async () => {
    let admissions = 0;
    const schema = rootSeriesSchema((value) => {
      admissions++;
      return `${value}-admitted`;
    });
    const database = new Database(":memory:");
    const world = await migratedWorld(
      schema,
      new WitnessSQLiteDriver({ client: database })
    );
    try {
      const existingAuthor = await world.client.author.create({
        data: { name: "existing-author" },
      });
      await world.client.post.create({
        data: {
          id: 1,
          title: "kept",
          author: { connect: { id: existingAuthor.id } },
        },
      });
      admissions = 0;
      world.driver.resetObservations();

      await expect(
        world.candidate.execute("post", "createMany", {
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
        })
      ).resolves.toEqual([
        { id: 2, title: "prefix-admitted" },
        { id: 3, title: "suffix-admitted" },
      ]);

      assert.equal(admissions, 3, "each input row must be admitted once");
      assert.equal(world.driver.transactionCalls, 1);
      assert.equal(
        world.driver.controlStatements.filter((statement) =>
          statement.startsWith("SAVEPOINT ")
        ).length,
        3
      );
      assert.equal(
        world.driver.controlStatements.filter((statement) =>
          statement.startsWith("ROLLBACK TO SAVEPOINT ")
        ).length,
        1
      );
      assert.equal(
        world.driver.controlStatements.filter((statement) =>
          statement.startsWith("RELEASE SAVEPOINT ")
        ).length,
        3
      );
      await expect(
        world.client.author.findMany({ orderBy: { name: "asc" } })
      ).resolves.toMatchObject([
        { name: "existing-author" },
        { name: "prefix-author" },
        { name: "suffix-author" },
      ]);
      await expect(
        world.client.post.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([
        { id: 1, title: "kept-admitted" },
        { id: 2, title: "prefix-admitted" },
        { id: 3, title: "suffix-admitted" },
      ]);

      world.driver.resetObservations();
      const [left, right] = await Promise.all([
        world.candidate.execute("post", "createMany", {
          data: [
            {
              id: 4,
              title: "left",
              author: { create: { name: "left-author" } },
            },
          ],
          skipDuplicates: true,
          select: { id: true, title: true },
        }),
        world.candidate.execute("post", "createMany", {
          data: [
            {
              id: 5,
              title: "right",
              author: { create: { name: "right-author" } },
            },
          ],
          skipDuplicates: true,
          select: { id: true, title: true },
        }),
      ]);
      assert.deepEqual(left, [{ id: 4, title: "left-admitted" }]);
      assert.deepEqual(right, [{ id: 5, title: "right-admitted" }]);
      assert.equal(admissions, 5);
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("does not suppress or continue after member rollback cleanup fails", async () => {
    const schema = rootSeriesSchema();
    const database = new Database(":memory:");
    const driver = new WitnessSQLiteDriver({ client: database });
    const world = await migratedWorld(schema, driver);
    try {
      const existingAuthor = await world.client.author.create({
        data: { name: "existing-author" },
      });
      await world.client.post.create({
        data: {
          id: 1,
          title: "kept",
          author: { connect: { id: existingAuthor.id } },
        },
      });
      driver.resetObservations();
      const cleanupFailure = new Error(
        "controlled failure after member savepoint rollback"
      );
      driver.failAfterSavepointRollback = cleanupFailure;

      const failure = await world.candidate
        .execute("post", "createMany", {
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
              title: "must-not-run",
              author: { create: { name: "suffix-author" } },
            },
          ],
          skipDuplicates: true,
        })
        .catch((error: unknown) => error);

      assert(failure instanceof AggregateError);
      assert(failure.cause instanceof UniqueConstraintError);
      assert.equal(failure.errors[0], failure.cause);
      const reportedCleanup = failure.errors[1];
      assert(reportedCleanup instanceof QueryError);
      assert.equal(reportedCleanup.code, "V2001");
      assert.equal(reportedCleanup.message, "Query execution failed");
      assert(reportedCleanup.originalCause instanceof Error);
      assert.equal(
        reportedCleanup.originalCause.message,
        "Underlying error details redacted"
      );
      assert.equal(driver.failAfterSavepointRollback, undefined);
      assert.equal(
        driver.controlStatements.filter((statement) =>
          statement.startsWith("ROLLBACK TO SAVEPOINT ")
        ).length,
        1
      );
      await expect(
        world.client.author.findMany({ orderBy: { name: "asc" } })
      ).resolves.toMatchObject([{ name: "existing-author" }]);
      await expect(
        world.client.post.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([{ id: 1, title: "kept" }]);
    } finally {
      await closeWorld(world);
      database.close();
    }
  });

  it("suppresses a nested junction root but keeps descendant unique and root foreign-key failures fatal", async () => {
    const schema = junctionSeriesSchema();

    const suppressedDatabase = new Database(":memory:");
    const suppressed = await migratedWorld(
      schema,
      new WitnessSQLiteDriver({ client: suppressedDatabase })
    );
    try {
      await suppressed.client.vault.create({ data: { id: "v1" } });
      await suppressed.client.gem.create({
        data: { tag: "taken", holderId: null },
      });
      suppressed.driver.resetObservations();
      await suppressed.candidate.execute("vault", "update", {
        where: { id: "v1" },
        data: {
          gems: {
            createMany: {
              data: [
                {
                  tag: "taken",
                  holderId: null,
                  facets: { create: [{ id: "ghost", slug: "ghost" }] },
                },
                {
                  tag: "fresh",
                  holderId: null,
                  facets: { create: [{ id: "real", slug: "real" }] },
                },
              ],
              skipDuplicates: true,
            },
          },
        },
        select: { id: true },
      });
      await expect(
        suppressed.client.gem.findMany({
          where: { vaults: { some: { id: "v1" } } },
        })
      ).resolves.toMatchObject([{ tag: "fresh" }]);
      await expect(
        suppressed.client.facet.findMany({ orderBy: { id: "asc" } })
      ).resolves.toMatchObject([{ id: "real", slug: "real" }]);
    } finally {
      await closeWorld(suppressed);
      suppressedDatabase.close();
    }

    const descendantDatabase = new Database(":memory:");
    const descendant = await migratedWorld(
      junctionSeriesSchema(),
      new WitnessSQLiteDriver({ client: descendantDatabase })
    );
    try {
      await descendant.client.vault.create({ data: { id: "v1" } });
      await descendant.client.gem.create({
        data: {
          tag: "seed",
          holderId: null,
          facets: { create: [{ id: "seed", slug: "duplicate" }] },
        },
      });
      descendant.driver.resetObservations();
      await expect(
        descendant.candidate.execute("vault", "update", {
          where: { id: "v1" },
          data: {
            gems: {
              createMany: {
                data: [
                  { tag: "sibling", holderId: null },
                  {
                    tag: "doomed",
                    holderId: null,
                    facets: {
                      create: [{ id: "doomed", slug: "duplicate" }],
                    },
                  },
                ],
                skipDuplicates: true,
              },
            },
          },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      await expect(
        descendant.client.gem.findMany({ orderBy: { tag: "asc" } })
      ).resolves.toMatchObject([{ tag: "seed" }]);
      await expect(
        descendant.client.gem.findMany({
          where: { vaults: { some: { id: "v1" } } },
        })
      ).resolves.toEqual([]);
    } finally {
      await closeWorld(descendant);
      descendantDatabase.close();
    }

    const foreignKeyDatabase = new Database(":memory:");
    const foreignKey = await migratedWorld(
      junctionSeriesSchema(),
      new WitnessSQLiteDriver({ client: foreignKeyDatabase })
    );
    try {
      await foreignKey.client.vault.create({ data: { id: "v1" } });
      foreignKey.driver.resetObservations();
      await expect(
        foreignKey.candidate.execute("vault", "update", {
          where: { id: "v1" },
          data: {
            gems: {
              createMany: {
                data: [
                  { tag: "sibling", holderId: null },
                  { tag: "doomed", holderId: "missing-holder" },
                ],
                skipDuplicates: true,
              },
            },
          },
        })
      ).rejects.toBeInstanceOf(ForeignKeyError);
      await expect(foreignKey.client.gem.findMany({})).resolves.toEqual([]);
    } finally {
      await closeWorld(foreignKey);
      foreignKeyDatabase.close();
    }
  });

  it("drops borrowed and batch-only suppression with one warning and runs plain members", async () => {
    // Owner decision 2026-09-24 ("Warn, drop skipDuplicates"): with no member
    // rollback region the skip is dropped, not refused — one warning per
    // client and model, every member runs as a plain member, and a duplicate
    // fails with the ordinary unique-constraint error.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const schema = rootSeriesSchema();
    const database = new Database(":memory:");
    const world = await migratedWorld(
      schema,
      new WitnessSQLiteDriver({ client: database })
    );
    const member = (id: number, author: string) => ({
      data: [{ id, title: `post-${id}`, author: { create: { name: author } } }],
      skipDuplicates: true,
    });
    try {
      await world.client.author.create({ data: { name: "existing-author" } });
      world.driver.resetObservations();
      await world.driver.withTransaction(async (driver) => {
        await expect(
          world.candidate.execute("post", "createMany", member(1, "created"), {
            kind: "borrowed-transaction",
            driver,
          })
        ).resolves.toEqual({ count: 1 });
      });
      await expect(
        world.driver.withTransaction((driver) =>
          world.candidate.execute(
            "post",
            "createMany",
            member(1, "must-roll-back"),
            { kind: "borrowed-transaction", driver }
          )
        )
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      assert.deepEqual(world.driver.controlStatements, []);
      expect(warn.mock.calls).toEqual([
        [
          `[viborm] createMany skipDuplicates cannot skip rows involving nested writes on driver "${world.driver.driverName}" (no savepoint available) in post.createMany; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`,
        ],
      ]);
      await expect(
        world.client.post.findMany({ select: { id: true, title: true } })
      ).resolves.toEqual([{ id: 1, title: "post-1" }]);
      await expect(
        world.client.author.findMany({
          select: { name: true },
          orderBy: { name: "asc" },
        })
      ).resolves.toEqual([{ name: "created" }, { name: "existing-author" }]);
    } finally {
      await closeWorld(world);
      database.close();
    }

    warn.mockClear();
    const batchDatabase = new Database(":memory:");
    const batch = await migratedWorld(
      rootSeriesSchema(),
      new BatchOnlySQLiteDriver({ client: batchDatabase })
    );
    try {
      batch.driver.resetObservations();
      batch.driver.batchCalls = 0;
      await expect(
        batch.candidate.execute("post", "createMany", member(1, "created"))
      ).resolves.toEqual({ count: 1 });
      assert.equal(batch.driver.batchCalls, 1);
      await expect(
        batch.candidate.execute(
          "post",
          "createMany",
          member(1, "must-roll-back")
        )
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      expect(warn.mock.calls).toEqual([
        [
          `[viborm] createMany skipDuplicates cannot skip rows involving nested writes on driver "${batch.driver.driverName}" (no savepoint available) in post.createMany; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`,
        ],
      ]);
      await expect(
        batch.client.post.findMany({ select: { id: true, title: true } })
      ).resolves.toEqual([{ id: 1, title: "post-1" }]);
      await expect(
        batch.client.author.findMany({ select: { name: true } })
      ).resolves.toEqual([{ name: "created" }]);
    } finally {
      await closeWorld(batch);
      batchDatabase.close();
      warn.mockRestore();
    }
  });

  it("routes the dropped-skip warning through the client's logger once, and to the console when warnings are not logged", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const member = (id: number) => ({
      data: [
        { id, title: `post-${id}`, author: { create: { name: `a-${id}` } } },
      ],
      skipDuplicates: true,
    });
    const message = (driver: string) =>
      `createMany skipDuplicates cannot skip rows involving nested writes on driver "${driver}" (no savepoint available) in post.createMany; running without skipDuplicates — a duplicate will fail with a unique-constraint error.`;
    const database = new Database(":memory:");
    const world = await migratedWorld(
      rootSeriesSchema(),
      new BatchOnlySQLiteDriver({ client: database })
    );
    try {
      const events: LogEvent[] = [];
      const logged = world.client.$extends(
        instrumentation({
          logging: {
            warning: (event) => {
              events.push(event);
            },
          },
        })
      );
      await expect(logged.post.createMany(member(1))).resolves.toEqual({
        count: 1,
      });
      await expect(logged.post.createMany(member(2))).resolves.toEqual({
        count: 1,
      });
      expect(events).toMatchObject([
        {
          level: "warning",
          model: "post",
          operation: "createMany",
          meta: { notice: message(world.driver.driverName) },
        },
      ]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      await closeWorld(world);
      database.close();
    }

    const quietDatabase = new Database(":memory:");
    const quiet = await migratedWorld(
      rootSeriesSchema(),
      new BatchOnlySQLiteDriver({ client: quietDatabase })
    );
    try {
      const queriesOnly = quiet.client.$extends(
        instrumentation({ logging: { query: () => undefined } })
      );
      await expect(queriesOnly.post.createMany(member(1))).resolves.toEqual({
        count: 1,
      });
      expect(warn.mock.calls).toEqual([
        [`[viborm] ${message(quiet.driver.driverName)}`],
      ]);
    } finally {
      await closeWorld(quiet);
      quietDatabase.close();
      warn.mockRestore();
    }
  });

  it("replans one exact conditional skip without repeating admission", async () => {
    let admissions = 0;
    const user = s
      .model({
        id: s.int().id(),
        email: s.string().unique(),
        count: s.int(),
        label: s.string().schema(
          v.string({
            transform(value) {
              admissions++;
              return value;
            },
          })
        ),
      })
      .map("g3p04_conditional_users");
    const schema = { user };
    const database = new Database(":memory:");
    const driver = new BatchOnlySQLiteDriver({ client: database });
    const world = await migratedWorld(schema, driver);
    try {
      await world.client.user.create({
        data: { id: 1, email: "wanted", count: 10, label: "initial" },
      });
      admissions = 0;
      driver.resetObservations();
      driver.batchCalls = 0;
      driver.beforeFirstBatch = () => {
        const changed = database
          .prepare(
            "UPDATE g3p04_conditional_users SET count = 999 WHERE id = 1"
          )
          .run();
        assert.equal(changed.changes, 1);
      };

      await expect(
        world.candidate.execute("user", "upsert", {
          where: { email: "wanted" },
          targetWhere: { count: 999 },
          create: {
            id: 42,
            email: "wanted",
            count: 0,
            label: "must-not-create",
          },
          update: { label: "updated" },
          select: { id: true, email: true, count: true, label: true },
        })
      ).resolves.toEqual({
        id: 1,
        email: "wanted",
        count: 999,
        label: "updated",
      });
      assert.equal(
        admissions,
        2,
        "create and update arms are each admitted once"
      );
      assert.equal(
        driver.batchCalls,
        2,
        "one exact retry must replace one rejected attempt"
      );
      assert.equal(
        driver.statements.filter(({ sql }) => /^INSERT\b/.test(sql)).length,
        0,
        "skip-to-match must not attempt the missing INSERT"
      );
    } finally {
      await closeWorld(world);
      database.close();
    }
  });
});
