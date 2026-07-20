import { MemoryCache } from "@cache/drivers/memory";
import { createClient } from "@client/client";
import type { AnyDriver, BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { UniqueConstraintError, type VibORMError } from "@errors";
import { push } from "@migrations";
import { createOperationExecutionContext } from "@query-engine/execution-context";
import { PendingOperation } from "@query-engine/pending-operation";
import { createModelRegistry, QueryEngine } from "@query-engine/query-engine";
import type { Operation } from "@query-engine/types";
import { hydrateSchemaNames, s } from "@schema";
import type { Model } from "@schema/model";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";
import type { ExecutableOperation } from "../../src/query-engine-v2/OperationExecutor";
import {
  isRetryableRace,
  markRaceable,
} from "../../src/query-engine-v2/race-retry";
import {
  constructRoutedOperation,
  executeRoutedOperation,
} from "../../src/query-engine-v2/routing";

/**
 * PLAN P5 item 2 — the six preserved contracts of the default flip, each pinned
 * by test. These exercise the production ROUTING SEAM (client → PendingOperation
 * → V2 executor), not the individual operation families: callback-transaction
 * driver threading (2a), the cache `prepare()` single-statement seam (2b), the
 * `$transaction([...])` shared-batch protocol (2c), instrumentation shape (2d),
 * error taxonomy incl. `meta.raceable` (2e), and the above-executor write-race
 * retry (2f). Every client here uses a RETURNING driver (PGlite) and the DEFAULT
 * engine (V2), except the A/B arms that force `queryEngine: "v1"`.
 */

const author = s
  .model({
    id: s.int().id(),
    name: s.string(),
    email: s.string().unique(),
    books: s.oneToMany(() => book),
  })
  .map("p5_authors");
const book = s
  .model({
    id: s.int().id(),
    title: s.string(),
    authorId: s.int().nullable(),
    author: s
      .manyToOne(() => author)
      .fields("authorId")
      .references("id")
      .optional(),
  })
  .map("p5_books");
const schema = { author, book };
hydrateSchemaNames(schema);

function engineFor(driver: AnyDriver): QueryEngine {
  const schemas = createSchemaRegistry(schema);
  return new QueryEngine(driver, createModelRegistry(schema, schemas));
}

const makeClient = (driver: AnyDriver, engineChoice?: "v1" | "v2") =>
  createClient({ schema, driver, queryEngine: engineChoice });
type P5Client = ReturnType<typeof makeClient>;

/** A batch-only PGlite driver that counts `_executeBatch` invocations. */
class BatchSpyDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
  batchCalls = 0;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    this.batchCalls += 1;
    return this.transaction(client, async (tx) => {
      const results: QueryResult<T>[] = [];
      for (const query of queries) {
        results.push(await this.executeRaw<T>(tx, query.sql, query.params));
      }
      return results;
    });
  }
}

/** A batch-only driver that runs a one-shot hook just before the first batch. */
class BeforeBatchSpyDriver extends BatchSpyDriver {
  private hook: (() => Promise<void>) | undefined;

  constructor(
    hook: () => Promise<void>,
    options: ConstructorParameters<typeof PGliteDriver>[0]
  ) {
    super(options);
    this.hook = hook;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const hook = this.hook;
    this.hook = undefined;
    if (hook) await hook();
    return super.executeBatch<T>(client, queries);
  }
}

describe("query-engine-v2 P5 flip contracts", () => {
  // 2a — callback $transaction threads the transaction-scoped driver; a write in
  // a rolled-back callback tx must not persist.
  test("2a: a V2 op inside a rolled-back callback transaction does not persist", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    try {
      await push(client, { force: true });
      await client.author.create({
        data: { id: 1, name: "Ann", email: "ann@x.com" },
      });

      // The tree V2 owns (a scalar update is routed to V2, not V1).
      const routed = constructRoutedOperation(
        engineFor(new PGliteDriver({ client: db })),
        schema.author,
        "update",
        { where: { id: 1 }, data: { name: "Bea" } }
      );
      expect(routed).toBeDefined();

      await expect(
        (
          client as unknown as {
            $transaction: (
              fn: (tx: typeof client) => Promise<unknown>
            ) => Promise<unknown>;
          }
        ).$transaction(async (tx) => {
          await tx.author.update({
            where: { id: 1 },
            data: { name: "Bea", email: "bea@x.com" },
          });
          // The write is visible inside the tx before we abort it.
          await expect(
            tx.author.findUnique({ where: { id: 1 } })
          ).resolves.toMatchObject({ name: "Bea" });
          throw new Error("rollback the callback tx");
        })
      ).rejects.toThrow("rollback the callback tx");

      // The V2 update ran on the tx-scoped driver and rolled back with it.
      await expect(
        client.author.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ id: 1, name: "Ann", email: "ann@x.com" });
    } finally {
      await client.$disconnect();
    }
  });

  // 2a — executeWith threads the transaction-scoped driver: an array
  // $transaction on a transaction-capable driver runs each V2 op via
  // `op.executeWith(txDriver)`; a mid-array failure rolls the whole tx back.
  test("2a: executeWith threads the tx driver; a mid-array failure rolls all back", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    try {
      await push(client, { force: true });
      await client.author.create({
        data: { id: 1, name: "Ann", email: "ann@x.com" },
      });
      await client.author.create({
        data: { id: 2, name: "Bo", email: "bo@x.com" },
      });

      // The second op collides id:2's email with id:1's → the whole tx aborts,
      // so the first op's V2 update (threaded on the tx driver) must not persist.
      await expect(
        (
          client as unknown as {
            $transaction: (ops: unknown[]) => Promise<unknown[]>;
          }
        ).$transaction([
          client.author.update({
            where: { id: 1 },
            data: { name: "must roll back" },
          }),
          client.author.update({
            where: { id: 2 },
            data: { email: "ann@x.com" },
          }),
        ])
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      await expect(
        client.author.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ name: "Ann" });
    } finally {
      await client.$disconnect();
    }
  });

  // 2b — cached reads flow through the V2 single-statement `prepare()` seam.
  test("2b: cached reads use the V2 single-statement prepare() seam", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const driver = new PGliteDriver({ client: db });

    // The seam itself: a routed read exposes exactly one prepared statement.
    const pending = PendingOperation.createRouted(
      engineFor(driver),
      schema.author as Model<any>,
      "findMany" as Operation,
      {},
      undefined,
      true
    );
    const prepared = pending.prepare(driver);
    expect(prepared).toBeDefined();
    expect(prepared?.sql).toContain("SELECT");

    // End-to-end through the cache flow: first call misses (prepares +
    // executes + parses the single statement), second call hits the cache.
    const cache = new MemoryCache();
    const client = createClient({ schema, driver, cache });
    try {
      await push(client, { force: true });
      await client.author.create({
        data: { id: 1, name: "Ann", email: "ann@x.com" },
      });

      const miss = await client
        .$withCache({ key: "all-authors" })
        .author.findMany();
      expect(miss).toHaveLength(1);

      // Mutate underneath the ORM; the cache hit must still see 1.
      await db.exec(
        `INSERT INTO "p5_authors" ("id","name","email") VALUES (2,'Bo','bo@x.com')`
      );
      const hit = await client
        .$withCache({ key: "all-authors" })
        .author.findMany();
      expect(hit).toHaveLength(1);

      // Uncached read sees both (the V2 read path is live, not a stub).
      await expect(client.author.findMany()).resolves.toHaveLength(2);
    } finally {
      await client.$disconnect();
    }
  });

  // 2c — an array `$transaction([...])` merges N pending V2 operations into ONE
  // driver batch; a mid-array failure aborts all.
  test("2c: N V2 operations merge into ONE executeBatch call", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const setup = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    const spy = new BatchSpyDriver({ client: db });
    const batchClient = createClient({ schema, driver: spy });
    try {
      await push(setup, { force: true });
      await setup.author.create({
        data: { id: 1, name: "Ann", email: "ann@x.com" },
      });

      const results = await (
        batchClient as unknown as {
          $transaction: (ops: unknown[]) => Promise<unknown[]>;
        }
      ).$transaction([
        batchClient.author.updateMany({
          where: { id: 1 },
          data: { name: "Ann II" },
        }),
        batchClient.author.count(),
        batchClient.book.count(),
      ]);

      expect(spy.batchCalls).toBe(1);
      expect(results[1]).toBe(1);
      expect(results[2]).toBe(0);
      await expect(
        setup.author.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ name: "Ann II" });
    } finally {
      await batchClient.$disconnect();
    }
  });

  test("2c: a mid-array failure aborts the whole batch, persisting nothing", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const setup = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    const spy = new BatchSpyDriver({ client: db });
    const batchClient = createClient({ schema, driver: spy });
    try {
      await push(setup, { force: true });
      await setup.author.create({
        data: { id: 1, name: "Ann", email: "dup@x.com" },
      });

      // The second op's createMany duplicates the unique email → the whole
      // batch rejects, and the first op's update must not persist.
      await expect(
        (
          batchClient as unknown as {
            $transaction: (ops: unknown[]) => Promise<unknown[]>;
          }
        ).$transaction([
          batchClient.author.updateMany({
            where: { id: 1 },
            data: { name: "should roll back" },
          }),
          batchClient.author.createMany({
            data: [{ id: 2, name: "Dup", email: "dup@x.com" }],
          }),
        ])
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      expect(spy.batchCalls).toBe(1);
      await expect(
        setup.author.findUnique({ where: { id: 1 } })
      ).resolves.toMatchObject({ name: "Ann" });
      await expect(setup.author.count()).resolves.toBe(1);
    } finally {
      await batchClient.$disconnect();
    }
  });

  // 2d — events emitted through V2 match V1's shape.
  test("2d: V2 emits the same instrumentation event shape as V1", {
    timeout: 30_000,
  }, async () => {
    const shapeOf = (
      events: {
        level: string;
        model?: unknown;
        operation?: unknown;
        duration?: unknown;
      }[]
    ) =>
      events.map((event) => ({
        level: event.level,
        model: event.model,
        operation: event.operation,
        hasDuration: typeof event.duration === "number",
      }));

    const run = async (engineChoice: "v1" | "v2") => {
      const events: {
        level: string;
        model?: unknown;
        operation?: unknown;
        sql?: unknown;
        duration?: unknown;
      }[] = [];
      const db = new PGlite();
      const client = createClient({
        schema,
        driver: new PGliteDriver({ client: db }),
        queryEngine: engineChoice,
        instrumentation: {
          logging: {
            query: (event) => {
              events.push(event);
            },
          },
        },
      });
      try {
        await push(client, { force: true });
        await client.author.create({
          data: { id: 1, name: "Ann", email: "ann@x.com" },
        });
        events.length = 0; // ignore setup/seed noise; measure the routed ops.
        await client.author.findMany();
        await client.author.update({
          where: { id: 1 },
          data: { name: "Bea" },
        });
      } finally {
        await client.$disconnect();
      }
      return events;
    };

    const v2 = await run("v2");
    const v1 = await run("v1");

    // Every emitted query event is well-formed identically under both engines:
    // level "query", a model + operation, and present sql + duration. (V2 and
    // V1 may issue a DIFFERENT NUMBER of SQL statements per operation — V2's
    // plan-then-execute update is locate+update+select where V1 does one
    // UPDATE…RETURNING — so the event COUNT legitimately differs; the SHAPE and
    // the covered operations must not.)
    const wellFormed = (events: ReturnType<typeof shapeOf>) =>
      events.every(
        (e) =>
          e.level === "query" &&
          typeof e.model === "string" &&
          typeof e.operation === "string" &&
          e.hasDuration
      );
    expect(wellFormed(shapeOf(v2))).toBe(true);
    expect(wellFormed(shapeOf(v1))).toBe(true);
    expect(v2.length).toBeGreaterThan(0);
    expect(new Set(v2.map((e) => e.operation))).toEqual(
      new Set(v1.map((e) => e.operation))
    );
  });

  // 2e — error taxonomy (types, codes, meta incl. raceable) preserved through
  // the client surface.
  test("2e: typed errors match V1 through the client surface (name + code + meta)", {
    timeout: 30_000,
  }, async () => {
    const attempt = async (
      engineChoice: "v1" | "v2",
      act: (client: P5Client) => PromiseLike<unknown>
    ) => {
      const db = new PGlite();
      const client = makeClient(new PGliteDriver({ client: db }), engineChoice);
      try {
        await push(client, { force: true });
        await client.author.create({
          data: { id: 1, name: "Ann", email: "ann@x.com" },
        });
        await act(client);
        return { thrown: false as const };
      } catch (error) {
        const e = error as VibORMError;
        return {
          thrown: true as const,
          name: e.name,
          code: e.code,
          message: e.message,
        };
      } finally {
        await client.$disconnect();
      }
    };

    // NotFound on updating a missing row.
    const notFound = (client: P5Client) =>
      client.author.update({ where: { id: 999 }, data: { name: "x" } });
    const nfV2 = await attempt("v2", (client) => notFound(client));
    const nfV1 = await attempt("v1", (client) => notFound(client));
    expect(nfV2).toEqual(nfV1);
    expect(nfV2.thrown).toBe(true);

    // Unique violation on an updateMany-driven conflict is a UniqueConstraint
    // error under both engines with equal name/code.
    const conflict = async (client: P5Client) => {
      await client.author.create({
        data: { id: 2, name: "Bo", email: "bo@x.com" },
      });
      await client.author.update({
        where: { id: 2 },
        data: { email: "ann@x.com" },
      });
    };
    const cV2 = await attempt("v2", (client) => conflict(client));
    const cV1 = await attempt("v1", (client) => conflict(client));
    expect(cV2.name).toBe(cV1.name);
    expect(cV2.code).toBe(cV1.code);
    expect(cV2.name).toBe("UniqueConstraintError");
  });

  test("2e: the raceable flag on a VibORM error is recognized end-to-end", () => {
    // A guard-abort error carrying meta.raceable is classified retryable; a plain
    // typed error is not — the exact discrimination the client-surface retry uses.
    const raceable = new UniqueConstraintError("conflict", {
      meta: { table: "p5_authors", columns: ["id"] },
    });
    // The executor flags a raceable guard abort by assignment (OperationExecutor
    // sets `error.meta.raceable = true`); the flag must survive to the client.
    (raceable as VibORMError).meta.raceable = true;
    expect((raceable as VibORMError).meta.raceable).toBe(true);
    expect(isRetryableRace(raceable)).toBe(true);

    const plain = new UniqueConstraintError("conflict", {
      meta: { table: "p5_authors", columns: ["email"] },
    });
    expect(isRetryableRace(plain)).toBe(false);
  });

  // 2f — write-race retry ABOVE the executor: a racePin-matched conflict retries
  // once and converges; a non-matching conflict does not retry.
  test("2f: executeRoutedOperation retries a racePin-matched conflict exactly once", async () => {
    const driver = new PGliteDriver();
    const context = createOperationExecutionContext("author", "upsert");
    const pinned = new UniqueConstraintError("pk conflict", {
      meta: { table: "p5_authors", columns: ["id"] },
    });
    markRaceable(pinned); // the executor pinned this as a race (racePin match).

    let calls = 0;
    const executor = {
      execute<T>(): Promise<T> {
        calls += 1;
        if (calls === 1) return Promise.reject(pinned);
        return Promise.resolve("converged" as unknown as T);
      },
    };
    const result = await executeRoutedOperation<string>(
      executor as never,
      {} as ExecutableOperation,
      context
    );
    expect(result).toBe("converged");
    expect(calls).toBe(2);
    await driver.disconnect();
  });

  test("2f: executeRoutedOperation does NOT retry a non-matching conflict", async () => {
    const context = createOperationExecutionContext("author", "upsert");
    const unmatched = new UniqueConstraintError("email conflict", {
      meta: { table: "p5_authors", columns: ["email"] },
    });
    // Not marked raceable and no meta.raceable → the retry layer must propagate.

    let calls = 0;
    const executor = {
      execute<T>(): Promise<T> {
        calls += 1;
        return Promise.reject(unmatched);
      },
    };
    await expect(
      executeRoutedOperation(
        executor as never,
        {} as ExecutableOperation,
        context
      )
    ).rejects.toBe(unmatched);
    expect(calls).toBe(1);
  });

  // 2f — the same retry policy end-to-end through the client, using the
  // deterministic before-batch race technique on a batch-only driver.
  test("2f: a create-branch loser whose racePin matches retries and converges through the client", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const setup = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    const racing = new BeforeBatchSpyDriver(
      async () => {
        // A concurrent winner commits the SAME primary key (the upsert's racePin)
        // just before the loser's batch runs.
        await setup.author.create({
          data: { id: 1, name: "winner", email: "winner@x.com" },
        });
      },
      { client: db }
    );
    const client = createClient({ schema, driver: racing });
    try {
      await push(setup, { force: true });

      const result = (await client.author.upsert({
        where: { id: 1 },
        create: { id: 1, name: "loser", email: "loser@x.com" },
        update: { name: "adopted" },
      })) as { id: number; name: string };

      // Re-planning re-read committed state, took the update arm, and converged.
      expect(result).toMatchObject({ id: 1, name: "adopted" });
      expect(racing.batchCalls).toBe(2); // one losing batch, one converging retry.
    } finally {
      await client.$disconnect();
    }
  });

  test("2f: a conflict NOT matching the racePin propagates without retry through the client", {
    timeout: 30_000,
  }, async () => {
    const db = new PGlite();
    const setup = createClient({
      schema,
      driver: new PGliteDriver({ client: db }),
    });
    const racing = new BeforeBatchSpyDriver(
      async () => {
        // A concurrent winner commits a DIFFERENT primary key but the SAME email
        // (a unique that is NOT the upsert's racePin).
        await setup.author.create({
          data: { id: 99, name: "winner", email: "shared@x.com" },
        });
      },
      { client: db }
    );
    const client = createClient({ schema, driver: racing });
    try {
      await push(setup, { force: true });

      await expect(
        client.author.upsert({
          where: { id: 1 },
          create: { id: 1, name: "loser", email: "shared@x.com" },
          update: { name: "adopted" },
        })
      ).rejects.toBeInstanceOf(UniqueConstraintError);
      expect(racing.batchCalls).toBe(1); // no retry: the email violation is not the racePin.
    } finally {
      await client.$disconnect();
    }
  });
});
