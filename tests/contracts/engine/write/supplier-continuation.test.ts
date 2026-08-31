import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { UnsupportedOperationError } from "@errors";

import { s } from "@schema";
import type { CommittedBatchNotification } from "@src/drivers/types";
import {
  registerSupplierContinuationBehavior,
  registerSupplierContinuationRefusals,
  resetSupplierContinuation,
  supplierContinuationSchema,
} from "@tests/contracts/engine/write/supplier-continuation-behavior";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";

import { openTestPGlite as openBorrowedPGlite } from "@tests/fixtures/pglite-lifecycle";


const SEGMENT_REFUSAL =
  /cannot execute this record series as committed segments/;
const BADGE_INSERT = /^INSERT INTO (?:"[^"]+"\.)?"e7_badges"/;
const BADGE_UPDATE = /^UPDATE (?:"[^"]+"\.)?"e7_badges"/;
const ANY_SELECT = /^SELECT/;
const PARENT_MOVED = /parent record changed across a committed segment/;

/** PACKAGE E — the composed continuation on interactive and batch substrates. */
let transactionClient: any;
registerSupplierContinuationBehavior("PGlite transaction", async () => {
  if (!transactionClient) {
    transactionClient = createClient({
      schema: supplierContinuationSchema,
      driver: new PGliteDriver({ client: openBorrowedPGlite() }),
    }) as any;
    await syncLiveSchema(transactionClient);
  }
  return transactionClient;
});

registerSupplierContinuationRefusals("PGlite transaction", async () => {
  if (!transactionClient) {
    transactionClient = createClient({
      schema: supplierContinuationSchema,
      driver: new PGliteDriver({ client: openBorrowedPGlite() }),
    }) as any;
    await syncLiveSchema(transactionClient);
  }
  return transactionClient;
});

let batchClient: any;
let batchDriver: BatchOnlyPGliteDriver | undefined;
const openBatch = async () => {
  if (!batchClient) {
    batchDriver = new BatchOnlyPGliteDriver({ client: openBorrowedPGlite() });
    batchClient = createClient({
      schema: supplierContinuationSchema,
      driver: batchDriver,
    }) as any;
    await syncLiveSchema(batchClient);
  }
  return batchClient;
};

// The refusals below are OWNED by the schema and the own-write ledger, both of which
// answer before any substrate question, so the batch leg proves they are substrate-
// independent rather than accidentally shared.
registerSupplierContinuationRefusals("PGlite atomic batch", openBatch);

describe("E — the composed continuation on a capability-false batch", () => {
  test("runs the same supplier and continuation state as the acknowledged route", async () => {
    const client = await openBatch();
    await resetSupplierContinuation(client);
    if (!batchDriver) throw new Error("batch driver was not provisioned");
    expect(batchDriver.supportsOrderedCommittedSegments).toBe(false);

    await client.station.update({
      where: { id: "s2" },
      data: {
        badge: {
          create: { id: "b-new", tag: "fresh", rank: 2 },
          update: { rank: { increment: 3 } },
        },
      },
    });

    expect(
      (await client.badge.findMany({}))
        .map((row: any) => [row.id, row.tag, row.rank, row.stationId])
        .sort((left: unknown[], right: unknown[]) =>
          String(left[0]) < String(right[0]) ? -1 : 1
        )
    ).toEqual([
      ["b-alt", "alt", 5, null],
      ["b-new", "fresh", 5, "s2"],
      ["b1", "incumbent", 1, "s1"],
    ]);
  });
});

/**
 * E4 — progressive batch substrates.
 *
 * A driver that cannot open a transaction but CAN execute native atomic batches runs
 * the continuation the same way it runs a nested relation-bearing `updateMany`: the
 * placement carries the complete-parent guard into every later batch, and the series
 * member re-asserts the captured target and its membership before it writes. The
 * stronger acknowledged-commit driver below additionally exposes exact boundary
 * timing; the capability-false test above proves it is not an eligibility gate.
 */
class ProgressiveBatchOnlyPGliteDriver extends BatchOnlyPGliteDriver {
  override readonly supportsOrderedCommittedSegments = true;
  batches: string[][] = [];
  afterCommittedBatch:
    | {
        readonly matches: (statements: readonly string[]) => boolean;
        readonly run: () => Promise<void>;
      }
    | undefined;

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[],
    _context?: QueryExecutionContext,
    committed?: CommittedBatchNotification
  ): Promise<QueryResult<T>[]> {
    this.batches.push(queries.map((query) => query.sql));
    const results = await super.executeBatch<T>(client, queries);
    await committed?.();
    const statements = queries.map((query) => query.sql);
    const hook = this.afterCommittedBatch;
    if (hook?.matches(statements)) {
      this.afterCommittedBatch = undefined;
      await hook.run();
    }
    return results;
  }
}

describe("E4 — the composed continuation on ordered committed segments", () => {
  let progressive: ProgressiveBatchOnlyPGliteDriver | undefined;
  let progressiveClient: any;
  const openProgressive = async () => {
    if (!progressiveClient) {
      progressive = new ProgressiveBatchOnlyPGliteDriver({
        client: openBorrowedPGlite(),
      });
      progressiveClient = createClient({
        schema: supplierContinuationSchema,
        driver: progressive,
      }) as any;
      await syncLiveSchema(progressiveClient);
    }
    return progressiveClient;
  };

  test("carries the parent and captured-target guards into every later segment", async () => {
    const client = await openProgressive();
    await resetSupplierContinuation(client);
    if (!progressive) throw new Error("driver was not provisioned");
    progressive.batches = [];

    await client.station.update({
      where: { id: "s2" },
      data: {
        badge: {
          create: { id: "b-new", tag: "fresh", rank: 2 },
          update: { rank: { increment: 3 } },
        },
      },
    });

    // The state claim first: the supplier's row is the one continued, the incumbent
    // and the decoy are untouched, and the relative update counted from 2.
    expect(
      (await client.badge.findMany({}))
        .map((row: any) => [row.id, row.tag, row.rank, row.stationId])
        .sort((left: unknown[], right: unknown[]) =>
          String(left[0]) < String(right[0]) ? -1 : 1
        )
    ).toEqual([
      ["b-alt", "alt", 5, null],
      ["b-new", "fresh", 5, "s2"],
      ["b1", "incumbent", 1, "s1"],
    ]);

    // The GUARD claim: the batch that carries the continuation's UPDATE also carries
    // both re-pins, and it is a LATER batch than the supplier's INSERT — that split is
    // what makes the guards necessary, because the supplier is already committed.
    const supplier = progressive.batches.findIndex((batch) =>
      batch.some((statement) => BADGE_INSERT.test(statement))
    );
    const continuation = progressive.batches.findIndex((batch) =>
      batch.some((statement) => BADGE_UPDATE.test(statement))
    );
    expect(supplier).toBeGreaterThanOrEqual(0);
    expect(continuation).toBeGreaterThan(supplier);
    const guards = (progressive.batches[continuation] ?? []).filter(
      (statement) => ANY_SELECT.test(statement)
    );
    // One guard names the PARENT row key; one names the captured badge and its
    // membership to that parent.
    expect(guards.some((guard) => guard.includes('"e7_stations"'))).toBe(true);
    expect(guards.some((guard) => guard.includes('"e7_badges"'))).toBe(true);
  });

  /**
   * The other half of E4, and the honest shape of it. `progressiveSeriesRefusal` is
   * the ONE owner of "this placement cannot run as committed segments", and every one
   * of its reasons is checked BEFORE the fragment's first segment is submitted
   * (`runProgressiveFragmentOperation` asserts capacity and boundary eligibility ahead
   * of `executeProgressiveFragment`). This pins that pre-effect property on the
   * composition's own placement, using the capacity reason because it is reachable.
   *
   * MEASURED, and recorded rather than contrived: the "cannot re-pin the complete
   * parent row key" reason is NOT reachable through this composition. The enclosing
   * update's own locate publishes the parent's complete row key, so the placement
   * always has row-key members to guard with — including when the root SET moves a
   * non-primary-key referenced value, which was tried and produced a guarded plan (and
   * then an ordinary foreign-key violation, a database fact about the payload rather
   * than a boundary refusal). That arm stays live for the placements that can reach
   * it — the junction and fresh-series ones, which have their own witnesses — and it
   * is the same function here, not a second copy.
   */
  test("routes the composition's placement through the pre-effect capacity refusal", async () => {
    const cramped = new ProgressiveBatchOnlyPGliteDriver({
      client: openBorrowedPGlite(),
    });
    const client = createClient({
      schema: supplierContinuationSchema,
      driver: cramped,
    }) as any;
    await syncLiveSchema(client);
    await resetSupplierContinuation(client);
    cramped.batches = [];
    // One bound value is below what the composition's own statements need. Apply
    // the synthetic limit after fixture setup so this witness measures only the
    // operation under test.
    Object.defineProperty(cramped, "maxBindParametersPerStatement", {
      value: 1,
    });

    let refusal: unknown;
    try {
      await client.station.update({
        where: { id: "s2" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh", rank: 2 },
            update: { tag: "continued" },
          },
        },
      });
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(UnsupportedOperationError);
    if (!(refusal instanceof UnsupportedOperationError)) throw refusal;
    expect(refusal.message).toMatch(SEGMENT_REFUSAL);
    // PRE-EFFECT: no batch was submitted at all, so the supplier did not commit.
    expect(cramped.batches).toEqual([]);
    expect(await client.badge.findMany({ where: { id: "b-new" } })).toEqual([]);
    await client.$disconnect();
  });
});

const nonPkSupplierSchema = (() => {
  const station = s
    .model({
      id: s.string().id(),
      code: s.string().unique(),
      badge: s.toOne(() => badge),
    })
    .map("e7np_stations");
  const badge = s
    .model({
      id: s.string().id(),
      tag: s.string(),
      stationCode: s.string().nullable().unique(),
      station: s
        .toOne(() => station)
        .fields("stationCode")
        .references("code")
        .onUpdate("cascade"),
    })
    .map("e7np_badges");
  return { badge, station };
})();

describe("E4 — supplier continuation keeps the write-side membership premise", () => {
  test("a reused non-PK reference cannot redirect the continuation", async () => {
    const database = openBorrowedPGlite();
    const progressive = new ProgressiveBatchOnlyPGliteDriver({
      client: database,
    });
    const client = createClient({
      schema: nonPkSupplierSchema,
      driver: progressive,
    }) as any;
    const concurrent = createClient({
      schema: nonPkSupplierSchema,
      driver: new PGliteDriver({ client: database }),
    }) as any;
    await syncLiveSchema(client);
    await concurrent.station.create({ data: { id: "p1", code: "A" } });
    await concurrent.station.create({ data: { id: "p2", code: "B" } });
    await concurrent.badge.create({
      data: { id: "b2", tag: "other", stationCode: "B" },
    });
    progressive.batches = [];
    progressive.afterCommittedBatch = {
      matches: (statements) =>
        statements.some(
          (statement) =>
            statement.startsWith("INSERT") &&
            statement.includes('"e7np_badges"')
        ),
      run: async () => {
        await concurrent.station.update({
          where: { id: "p1" },
          data: { code: "C" },
        });
        await concurrent.station.update({
          where: { id: "p2" },
          data: { code: "A" },
        });
      },
    };

    await expect(
      client.station.update({
        where: { id: "p1" },
        data: {
          badge: {
            create: { id: "b-new", tag: "fresh" },
            update: { tag: "continued" },
          },
        },
      })
    ).rejects.toThrow(PARENT_MOVED);

    await expect(
      concurrent.badge.findMany({
        orderBy: { id: "asc" },
        select: { id: true, tag: true, stationCode: true },
      })
    ).resolves.toEqual([
      { id: "b-new", tag: "fresh", stationCode: "C" },
      { id: "b2", tag: "other", stationCode: "A" },
    ]);
    await client.$disconnect();
  }, 60_000);
});
