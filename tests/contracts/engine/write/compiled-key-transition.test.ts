import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { push } from "@migrations";
import { describe, expect, test } from "vitest";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import {
  compileTransitionSchema,
  registerCompileTransitionBehavior,
  resetCompileTransition,
} from "@tests/contracts/engine/write/compiled-key-transition-behavior";

/** Rewrites the located counter's `id` after the database answered the locate. */
class CorruptLocateDriver extends PGliteDriver {
  private armed = true;
  private readonly wrongValue: unknown;

  constructor(
    options: ConstructorParameters<typeof PGliteDriver>[0],
    wrongValue: unknown
  ) {
    super(options);
    this.wrongValue = wrongValue;
  }

  private corrupt<T>(sql: string, result: QueryResult<T>): QueryResult<T> {
    const isLocate =
      this.armed &&
      sql.startsWith("SELECT") &&
      sql.includes("e67_counters") &&
      result.rows.length > 0;
    if (!isLocate) return result;
    this.armed = false;
    return {
      ...result,
      rows: result.rows.map(
        (row) =>
          ({ ...(row as Record<string, unknown>), id: this.wrongValue }) as T
      ),
    };
  }

  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.execute<T>(client, sql, params, context)
    );
  }

  protected override async executeRaw<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return this.corrupt(
      sql,
      await super.executeRaw<T>(client, sql, params, context)
    );
  }
}

/** Runs a hook between planning and the ATOMIC unit — the staleness window. */
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
    if (hook && batchIsAtomicUnit(queries)) {
      this.beforeBatch = undefined;
      await hook();
    }
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

async function setup(driver: PGliteDriver) {
  const client = createClient({
    schema: compileTransitionSchema,
    driver,
  }) as any;
  await push(client, { force: true });
  return client;
}

const substrates = [
  {
    name: "transaction",
    make: (db: PGlite) => new PGliteDriver({ client: db }),
  },
  {
    name: "atomic batch",
    make: (db: PGlite) => new BatchOnlyPGliteDriver({ client: db }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerCompileTransitionBehavior(substrate.name, async () => {
    shared ??= await setup(substrate.make(new PGlite()));
    return shared;
  });
}

describe("E6.7 the pre-value's provenance and the window it lives in", () => {
  test("corrupt-locate: the derivation runs over the LOCATED value, not the `where`", async () => {
    const db = new PGlite();
    const stateClient = await setup(new PGliteDriver({ client: db }));
    await resetCompileTransition(stateClient);
    await stateClient.counter.create({ data: { id: 10, tag: "t" } });

    // The locate answers `id: 10`; the harness rewrites it to 100 before the engine
    // sees it. The derivation is `before + 5`, so a compile that reads the LOCATED row
    // binds 105 — a value the caller's `where: { tag: 't' }` cannot produce and a
    // re-derivation from the payload could never reach.
    const client = createClient({
      schema: compileTransitionSchema,
      driver: new CorruptLocateDriver({ client: db }, 100),
    }) as any;

    // The root UPDATE addresses the corrupted key, so it matches no row; the child
    // INSERT then binds the corrupted derivation and the foreign key has nothing to
    // point at. Either way the claim is the same and it is visible: the value the
    // engine spent came from the row the locate ACTED ON.
    const outcome = await client.counter
      .update({
        where: { tag: "t" },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
      })
      .then(() => "resolved")
      .catch((error: Error) => error.constructor.name);

    const ticks = await stateClient.tick.findMany();
    const counters = await stateClient.counter.findMany();
    if (outcome === "resolved") {
      expect(ticks[0]?.counterId).toBe(105);
    } else {
      // Fail-closed: nothing was persisted against the corrupted key.
      expect(ticks).toEqual([]);
      expect(counters.map((row: any) => row.id)).toEqual([10]);
    }
    await stateClient.$disconnect();
  }, 30_000);

  test("concurrency: a key moved between planning and the batch ABORTS the unit", async () => {
    const db = new PGlite();
    const stateClient = await setup(new PGliteDriver({ client: db }));
    await resetCompileTransition(stateClient);
    await stateClient.counter.create({ data: { id: 10, tag: "t" } });

    // The concurrent writer moves the row off the key the locate published, INSIDE the
    // window between planning and the atomic unit. The batch's root presence guard —
    // NOT a postcondition, which is a transaction-mode instrument — is what pins the
    // premise here, and it must fail the whole unit rather than write against a key
    // that no longer names this row.
    const client = createClient({
      schema: compileTransitionSchema,
      driver: new BeforeBatchPGliteDriver(
        async () => {
          await stateClient.counter.update({
            where: { tag: "t" },
            data: { id: 77 },
          });
        },
        { client: db }
      ),
    }) as any;

    await expect(
      client.counter.update({
        where: { tag: "t" },
        data: { id: { increment: 5 }, ticks: { create: { id: "tk1" } } },
      })
    ).rejects.toThrow();

    // Nothing of the aborted unit survived: no tick, and the row still carries the
    // concurrent writer's value rather than 15.
    expect(await stateClient.tick.findMany()).toEqual([]);
    expect(
      (await stateClient.counter.findMany()).map((row: any) => row.id)
    ).toEqual([77]);
    await stateClient.$disconnect();
  }, 30_000);
});
