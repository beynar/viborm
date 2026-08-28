import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite, type Transaction } from "@electric-sql/pglite";

import {
  registerSharedPkConnectOrCreateBehavior,
  sharedPkConnectOrCreateSchema,
} from "@tests/contracts/engine/write/shared-pk-connect-or-create-behavior";
import { batchIsAtomicUnit } from "@tests/fixtures/atomic-unit-batch";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

/** The deterministic TOCTOU window: `beforeBatch` runs between the planning probe and
 *  the atomic WRITE batch (the `staleness-injection.test.ts` driver, same rule). */
class BeforeBatchPGliteDriver extends PGliteDriver {
  override readonly supportsTransactions = false;
  override readonly supportsBatch = true;
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
    if (hook && batchIsAtomicUnit(queries)) {
      this.hook = undefined;
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

const substrates = [
  {
    name: "PGlite transaction",
    make: () => new PGliteDriver({ client: new PGlite() }),
  },
  {
    name: "PGlite atomic batch",
    make: () => new BatchOnlyPGliteDriver({ client: new PGlite() }),
  },
  // The third dialect this fixture can express (its shared key is a string, so SQLite
  // has a table for it — unlike E6.2's generated compound key).
  {
    name: "better-sqlite3",
    make: () => new SQLite3Driver({ dataDir: ":memory:" }),
  },
] as const;

for (const substrate of substrates) {
  let shared: any;
  registerSharedPkConnectOrCreateBehavior(substrate.name, async () => {
    if (!shared) {
      shared = createClient({
        schema: sharedPkConnectOrCreateSchema,
        driver: substrate.make(),
      }) as any;
      await syncLiveSchema(shared);
    }
    return shared;
  });
}

test("BATCH TOCTOU: the found target deleted after planning aborts the batch, writing nothing", async () => {
  const db = new PGlite();
  const setup = createClient({
    schema: sharedPkConnectOrCreateSchema,
    driver: new PGliteDriver({ client: db }),
  }) as any;
  await syncLiveSchema(setup);
  await setup.user.create({ data: { id: "u1", email: "u1@x", name: "seed" } });

  // The probe finds `u1`, so the FOUND arm compiles (no user INSERT). The row then
  // vanishes before the write batch runs: the record's shared primary key is a live
  // foreign key, so the batch must abort rather than write an orphan.
  const racing = createClient({
    schema: sharedPkConnectOrCreateSchema,
    driver: new BeforeBatchPGliteDriver(
      async () => {
        await setup.user.delete({ where: { id: "u1" } });
      },
      { client: db }
    ),
  }) as any;

  const rejection = await racing.profile
    .create({
      data: {
        bio: "raced",
        user: {
          connectOrCreate: {
            where: { id: "u1" },
            create: { id: "u1", email: "u1@x", name: "seed" },
          },
        },
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  expect(rejection).toBeInstanceOf(Error);
  // Whatever the class, the batch is one unit: nothing persists.
  expect(await setup.profile.count()).toBe(0);
  expect(await setup.user.count()).toBe(0);
  // One PGlite instance backs both clients, so it is disconnected exactly once.
  await setup.$disconnect();
}, 30_000);

test("BATCH TOCTOU: an alternate-unique replacement cannot donate a different shared key", async () => {
  const db = new PGlite();
  const setup = createClient({
    schema: sharedPkConnectOrCreateSchema,
    driver: new PGliteDriver({ client: db }),
  }) as any;
  await syncLiveSchema(setup);
  await setup.user.create({ data: { id: "u1", email: "same@x", name: "old" } });

  const racing = createClient({
    schema: sharedPkConnectOrCreateSchema,
    driver: new BeforeBatchPGliteDriver(
      async () => {
        await setup.user.delete({ where: { id: "u1" } });
        await setup.user.create({
          data: { id: "replacement", email: "same@x", name: "new" },
        });
      },
      { client: db }
    ),
  }) as any;

  const rejection = await racing.profile
    .create({
      data: {
        bio: "must not spend stale u1",
        user: { connect: { email: "same@x" } },
      },
    })
    .then(
      () => undefined,
      (error: unknown) => error
    );

  expect(rejection).toBeInstanceOf(Error);
  expect(await setup.profile.count()).toBe(0);
  expect(
    await setup.user.findUnique({
      where: { email: "same@x" },
      select: { id: true },
    })
  ).toEqual({ id: "replacement" });
  await setup.$disconnect();
}, 30_000);
