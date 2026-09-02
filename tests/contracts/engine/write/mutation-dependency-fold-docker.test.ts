import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PgDriver } from "@drivers/pg";
import { UniqueConstraintError } from "@errors";

import { hydrateSchemaNames, s } from "@schema";
import { PgBatchForcedDriver } from "@tests/fixtures/drivers/batch-forced-pg";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type { Pool, PoolClient } from "pg";
import { afterAll, describe, expect, test } from "vitest";

/**
 * PACKAGE M on a live PostgreSQL server.
 *
 * Every other measurement in this package is taken on PGlite, which IS PostgreSQL
 * 16 — but compiled to WASM, single-connection, and running its own build of the
 * executor. The fold emits a shape nothing else in the repo emits (a chain of
 * data-modifying `WITH` arms in which a later arm reads an earlier arm's
 * `RETURNING` relation through a scalar subquery), and the three properties that
 * make it legal are all executor behaviour rather than syntax:
 *
 *  · a data-modifying arm runs exactly ONCE however many arms read it;
 *  · `CteScan` forces the producing arm's `ModifyTable` before its reader;
 *  · a constraint violated in ANY arm aborts the whole command.
 *
 * So this leg is not decoration. It is the difference between "the SQL parses on
 * the WASM build" and "the server does what the fold's legality argument says it
 * does". `mutation-dependency-fold.test.ts` holds the statement COUNTS and every
 * decline; this file holds the live answers.
 *
 * PostgreSQL only, by construction: `supportsCteWithMutations` is false on MySQL
 * and SQLite, so there is no folded command on either. Their portable series is
 * pinned byte-for-byte in `parity-m-create-dag.test.ts` and executed live in
 * `fresh-produced-field-docker.test.ts`.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

const PG = process.env.PG_TEST_CONNECTION_STRING;

const liveSchema = (() => {
  const hub = s
    .model({
      id: s.int().id().increment(),
      name: s.string(),
      spans: s.toMany(() => span),
    })
    .map("pmd_hubs");
  const span = s
    .model({
      id: s.string().id(),
      hubId: s.int().nullable(),
      hub: s
        .toOne(() => hub)
        .fields("hubId")
        .references("id"),
    })
    .map("pmd_spans");
  /** The `producer > 0` chain: an application-known root, a generated middle whose
   *  key is the produced value, and a leaf that spends it. Both keys are MAPPED,
   *  so addressing an arm by the wrong name raises rather than coinciding. */
  const crate = s
    .model({
      id: s.string().id().map("crate_pk"),
      pallets: s.toMany(() => pallet),
    })
    .map("pmd_crates");
  const pallet = s
    .model({
      id: s.int().id().increment().map("pallet_pk"),
      crateId: s.string().nullable(),
      crate: s
        .toOne(() => crate)
        .fields("crateId")
        .references("id"),
      labels: s.toMany(() => label),
    })
    .map("pmd_pallets");
  const label = s
    .model({
      id: s.string().id(),
      palletId: s.int().nullable(),
      pallet: s
        .toOne(() => pallet)
        .fields("palletId")
        .references("id"),
    })
    .map("pmd_labels");
  return { hub, span, crate, pallet, label };
})();

hydrateSchemaNames(liveSchema);

/** Records every statement at the protected seam a transaction-bound driver
 *  delegates back to (`delete-fold.test.ts` owns the explanation). */
class RecordingPgDriver extends PgDriver {
  readonly statements: string[] = [];
  recording = false;

  protected override execute<T>(
    client: Pool | PoolClient,
    statement: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(statement);
    return super.execute<T>(client, statement, params, context);
  }

  protected override executeRaw<T>(
    client: Pool | PoolClient,
    statement: string,
    params: unknown[] | undefined,
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.recording) this.statements.push(statement);
    return super.executeRaw<T>(client, statement, params, context);
  }
}

/** Records the one real PostgreSQL transaction submitted by the shared-array route. */
class RecordingBatchPgDriver extends PgBatchForcedDriver {
  readonly batches: BatchQuery[][] = [];

  override async _executeBatch<T = Record<string, unknown>>(
    ...args: Parameters<PgDriver["_executeBatch"]>
  ): Promise<QueryResult<T>[]> {
    this.batches.push([...args[0]]);
    return (await super._executeBatch(...args)) as QueryResult<T>[];
  }
}

// Children before parents, so a re-run never asks `syncLiveSchema(force)` to re-shape an
// index a live foreign key still needs.
const TABLES = [
  "pmd_labels",
  "pmd_pallets",
  "pmd_crates",
  "pmd_spans",
  "pmd_hubs",
];

let shared: any;
let driver: RecordingPgDriver | undefined;

async function connect(): Promise<any> {
  if (!shared) {
    driver = new RecordingPgDriver({ databaseUrl: PG as string });
    shared = createClient({ schema: liveSchema, driver }) as any;
    for (const table of TABLES) {
      await shared.$executeRawUnsafe(`DROP TABLE IF EXISTS ${table}`);
    }
    await syncLiveSchema(shared);
  }
  return shared;
}

function drain(): string[] {
  const recorded = driver?.statements ?? [];
  return recorded.splice(0, recorded.length);
}

afterAll(async () => {
  await shared?.$disconnect();
});

(PG ? describe : describe.skip)("PACKAGE M — live PostgreSQL", () => {
  test("a generated parent key reaches its child inside ONE command", async () => {
    const client = await connect();

    if (driver) driver.recording = true;
    const created = await client.hub.create({
      data: { name: "live-1", spans: { create: { id: "live-s1" } } },
      select: { id: true, name: true },
    });
    const statements = drain();
    if (driver) driver.recording = false;

    expect(statements).toHaveLength(1);
    expect(statements[0]?.startsWith("WITH ")).toBe(true);
    expect(created).toEqual({ id: created.id, name: "live-1" });
    // The server ran the producing arm before its reader, and ran it once.
    expect(await client.span.findMany({ where: { id: "live-s1" } })).toEqual([
      { id: "live-s1", hubId: created.id },
    ]);
  });

  test("TWO readers of one produced key both get it, and the parent runs once", async () => {
    const client = await connect();

    const created = await client.hub.create({
      data: {
        name: "live-2",
        spans: { create: [{ id: "live-s2a" }, { id: "live-s2b" }] },
      },
      select: { id: true },
    });

    expect(
      await client.span.findMany({
        where: { hubId: created.id },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: "live-s2a", hubId: created.id },
      { id: "live-s2b", hubId: created.id },
    ]);
    expect(
      await client.hub.findMany({ where: { name: "live-2" } })
    ).toHaveLength(1);
  });

  test("a SIBLING arm's generated key is spent by a third arm", async () => {
    const client = await connect();

    if (driver) driver.recording = true;
    await client.crate.create({
      data: {
        id: "live-cr1",
        pallets: { create: { labels: { create: { id: "live-lb1" } } } },
      },
      select: { id: true },
    });
    const statements = drain();
    if (driver) driver.recording = false;

    expect(statements).toHaveLength(1);
    const [pallet] = await client.pallet.findMany({
      where: { crateId: "live-cr1" },
    });
    expect(pallet?.id).toEqual(expect.any(Number));
    expect(await client.label.findMany({ where: { id: "live-lb1" } })).toEqual([
      { id: "live-lb1", palletId: pallet?.id },
    ]);
  });

  test("a violation in ANY arm aborts the whole command, leaving nothing", async () => {
    const client = await connect();

    await expect(
      client.hub.create({
        data: {
          name: "live-3",
          spans: { create: [{ id: "dup-live" }, { id: "dup-live" }] },
        },
      })
    ).rejects.toBeInstanceOf(UniqueConstraintError);
    // Not just the children: the ROOT the same command inserted is gone too.
    expect(await client.hub.findMany({ where: { name: "live-3" } })).toEqual(
      []
    );
    expect(await client.span.findMany({ where: { id: "dup-live" } })).toEqual(
      []
    );
  });

  test("an indivisible array folds a generated-key DAG in one real batch", async () => {
    const observer = await connect();
    const batchDriver = new RecordingBatchPgDriver({
      databaseUrl: PG as string,
    });
    const client = createClient({ schema: liveSchema, driver: batchDriver });
    try {
      const [created, sibling] = await client.$transaction([
        client.hub.create({
          data: {
            name: "live-array-fold",
            spans: { create: { id: "live-array-span" } },
          },
          select: { id: true, name: true },
        }),
        client.crate.create({ data: { id: "live-array-sibling" } }),
      ]);

      expect(created).toEqual({
        id: expect.any(Number),
        name: "live-array-fold",
      });
      expect(sibling).toEqual({ id: "live-array-sibling" });
      expect(batchDriver.batches).toHaveLength(1);
      expect(batchDriver.batches[0]).toHaveLength(2);
      expect(batchDriver.batches[0]?.[0]?.sql.startsWith("WITH ")).toBe(true);
      await expect(
        observer.span.findMany({ where: { id: "live-array-span" } })
      ).resolves.toEqual([{ id: "live-array-span", hubId: created.id }]);
    } finally {
      await client.$disconnect();
    }
  });

  test("a failing folded DAG rolls every real PostgreSQL array sibling back", async () => {
    const observer = await connect();
    const batchDriver = new RecordingBatchPgDriver({
      databaseUrl: PG as string,
    });
    const client = createClient({ schema: liveSchema, driver: batchDriver });
    try {
      await expect(
        client.$transaction([
          client.crate.create({ data: { id: "live-array-rolled-back" } }),
          client.hub.create({
            data: {
              name: "live-array-failing-dag",
              spans: {
                create: [
                  { id: "live-array-duplicate" },
                  { id: "live-array-duplicate" },
                ],
              },
            },
            select: { id: true },
          }),
        ])
      ).rejects.toBeInstanceOf(UniqueConstraintError);

      expect(batchDriver.batches).toHaveLength(1);
      expect(batchDriver.batches[0]).toHaveLength(2);
      expect(batchDriver.batches[0]?.[1]?.sql.startsWith("WITH ")).toBe(true);
      await expect(
        observer.crate.findUnique({ where: { id: "live-array-rolled-back" } })
      ).resolves.toBeNull();
      await expect(
        observer.hub.findMany({ where: { name: "live-array-failing-dag" } })
      ).resolves.toEqual([]);
      await expect(
        observer.span.findMany({ where: { id: "live-array-duplicate" } })
      ).resolves.toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
