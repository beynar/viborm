import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { NestedWriteError, NotFoundError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import { DeleteOperation } from "../../src/query-engine-v2/DeleteOperation";
import { OperationExecutor } from "../../src/query-engine-v2/OperationExecutor";
import { UpdateOperation } from "../../src/query-engine-v2/UpdateOperation";
import { updateFamilySchema } from "./update-family-behavior";

// ---------------------------------------------------------------------------
// Staleness injection (PLAN P2a instrument 3). The single-threaded dual-run
// oracle cannot observe raceability, so each existing-row premise class gets a
// deterministic before-batch driver hook: it mutates committed state AFTER V2's
// unlocked planning read decides the arm but BEFORE the atomic batch runs. The
// pinned guard must then abort the batch with its typed failure — proving the
// premise is actually pinned inside the atomic unit, not merely observed at
// planning. This is the coverage ATOM §8.1 note (b) said P2a adds.
// ---------------------------------------------------------------------------

/**
 * A batch-only PGlite driver that runs `beforeBatch` between planning and the
 * atomic batch — the deterministic staleness window.
 */
class BeforeBatchPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  private beforeBatch: (() => Promise<void>) | undefined;

  constructor(
    beforeBatch: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.beforeBatch = beforeBatch;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.beforeBatch;
    this.beforeBatch = undefined;
    if (hook) await hook();
    return this.transaction(client, async (transaction) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(
          await this.executeRaw<T>(transaction, query.sql, query.params)
        );
      }
      return results;
    });
  }
}

function makeClient(db: PGlite) {
  return createClient({
    schema: updateFamilySchema,
    driver: new PGliteDriver({ client: db }),
  });
}

/** Run a V2 update in forced-batch mode with a before-batch staleness hook. */
function runUpdate(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new UpdateOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "update",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

function runDelete(
  db: PGlite,
  beforeBatch: () => Promise<void>,
  modelName: string,
  model: Model<any>,
  args: Record<string, unknown>
): Promise<unknown> {
  const driver = new BeforeBatchPGliteDriver(beforeBatch, { client: db });
  const schemas = createSchemaRegistry(updateFamilySchema);
  const engine = new QueryEngine(
    driver,
    createModelRegistry(updateFamilySchema, schemas)
  );
  const executor = new OperationExecutor(engine);
  const operation = new DeleteOperation(engine, model, args);
  const context = createOperationExecutionContext(
    modelName,
    "delete",
    engine.instrumentation
  );
  return executor.execute(operation, context);
}

describe("query-engine-v2 staleness injection (per premise class)", () => {
  test("root-presence premise (update): a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "s@x", count: 1 } });

    // Planning locates the row; the hook deletes it before the batch runs. The
    // batch-mode root-presence assertion (ATOM §8.1 note (b)) must abort.
    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.user.delete({ where: { email: "s@x" } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "s@x" },
          data: { count: { increment: 1 } },
          select: { email: true, count: true },
        }
      )
    ).rejects.toBeInstanceOf(NotFoundError);

    // No partial mutation survived.
    await expect(client.user.findMany()).resolves.toEqual([]);
    await client.$disconnect();
  });

  test("root-presence premise (delete): a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "d@x", count: 1 } });

    const injector = makeClient(db);
    await expect(
      runDelete(
        db,
        async () => {
          await injector.user.delete({ where: { email: "d@x" } });
        },
        "user",
        updateFamilySchema.user,
        { where: { email: "d@x" }, select: { email: true } }
      )
    ).rejects.toBeInstanceOf(NotFoundError);
    await client.$disconnect();
  });

  test("disconnect-correlation premise: a concurrent reparent aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({
      data: {
        email: "owner@x",
        count: 0,
        posts: { create: { id: 5, title: "mine", slug: "s5" } },
      },
    });
    await client.user.create({ data: { email: "thief@x", count: 0 } });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          // Reparent post 5 away before the disconnect batch runs.
          await injector.post.update({
            where: { id: 5 },
            data: { userId: 2 },
          });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "owner@x" },
          data: { posts: { disconnect: { id: 5 } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);

    // Post 5 kept the injected parent — the disconnect never fired.
    await expect(
      client.post.findUnique({ where: { id: 5 } })
    ).resolves.toMatchObject({ userId: 2 });
    await client.$disconnect();
  });

  test("connect-target premise: a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({ data: { email: "c@x", count: 0 } });
    await client.post.create({
      data: { id: 6, title: "orphan", slug: "s6", userId: null },
    });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          await injector.post.delete({ where: { id: 6 } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "c@x" },
          data: { posts: { connect: { id: 6 } } },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);
    await client.$disconnect();
  });

  test("upsert found premise: a concurrent delete aborts the batch typed", async () => {
    const db = new PGlite();
    const client = makeClient(db);
    await push(client, { force: true });
    await client.user.create({
      data: {
        email: "up@x",
        count: 0,
        posts: { create: { id: 4, title: "old", slug: "s4" } },
      },
    });

    const injector = makeClient(db);
    await expect(
      runUpdate(
        db,
        async () => {
          // Delete the found child before the batch pins & updates it.
          await injector.post.delete({ where: { id: 4 } });
        },
        "user",
        updateFamilySchema.user,
        {
          where: { email: "up@x" },
          data: {
            posts: {
              upsert: {
                where: { id: 4 },
                create: { id: 4, title: "made", slug: "s4" },
                update: { title: "fresh" },
              },
            },
          },
          select: { email: true },
        }
      )
    ).rejects.toBeInstanceOf(NestedWriteError);
    await client.$disconnect();
  });
});
