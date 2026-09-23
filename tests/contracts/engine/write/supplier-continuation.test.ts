import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { PGliteDriver } from "@drivers/pglite";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { UnsupportedOperationError } from "@errors";

import { s } from "@schema";
import type { CommittedBatchNotification } from "@src/drivers/types";
import {
  registerSupplierContinuationBehavior,
  registerSupplierContinuationRefusals,
  resetSupplierContinuation,
  supplierContinuationSchema,
} from "@tests/contracts/engine/write/supplier-continuation-behavior";
import {
  BatchOnlyPGliteDriver,
  usePGliteSchemaFamily,
} from "@tests/fixtures/drivers/pglite";
import { describe, expect, test } from "vitest";

/**
 * The pre-effect capacity refusal, in the shipped engine's words.
 *
 * This pinned the RETIRED engine's `progressiveSeriesRefusal` sentence ("cannot
 * execute this record series as committed segments"); none of that owner's names
 * exist in `src/` any more. The shipped owner of the same pre-effect property is
 * `assertStatementBindParameterCapacity` (`src/drivers/bind-parameter-capacity.ts`),
 * called while a statement is MATERIALIZED (`driver-instrumentation.ts`) and
 * therefore before any batch is submitted — which is the property this cell exists
 * to measure. The bound-value count is the composition's own physical fact and is
 * left free; the driver, the subject, and the synthetic limit are pinned.
 */
const CAPACITY_REFUSAL =
  /^Driver 'pglite' cannot execute this operation because one indivisible statement needs \d+ bound values, above the verified limit of 1\.$/;
const BADGE_INSERT = /^INSERT INTO (?:"[^"]+"\.)?"e7_badges"/;
const BADGE_UPDATE = /^UPDATE (?:"[^"]+"\.)?"e7_badges"/;
const ANY_SELECT = /^SELECT/;
const PARENT_MOVED = /parent record changed across a committed segment/;

/** PACKAGE E — the composed continuation on interactive and batch substrates.
 *  Each substrate takes a private schema on the worker's shared database; every
 *  test re-seeds through `resetSupplierContinuation`, as it always did. */
const getTransactionFamily = usePGliteSchemaFamily(
  supplierContinuationSchema,
  "transaction"
);
const getBatchFamily = usePGliteSchemaFamily(
  supplierContinuationSchema,
  "atomicBatch"
);

const openTransaction = async () => getTransactionFamily().client as any;
registerSupplierContinuationBehavior("PGlite transaction", openTransaction);

registerSupplierContinuationRefusals("PGlite transaction", openTransaction);

const openBatch = async () => getBatchFamily().client as any;

// The refusals below are OWNED by the schema and the own-write ledger, both of which
// answer before any substrate question, so the batch leg proves they are substrate-
// independent rather than accidentally shared.
registerSupplierContinuationRefusals("PGlite atomic batch", openBatch);

describe("E — the composed continuation on a capability-false batch", () => {
  test("runs the same supplier and continuation state as the acknowledged route", async () => {
    const client = await openBatch();
    await resetSupplierContinuation(client);
    expect(getBatchFamily().driver.supportsOrderedCommittedSegments).toBe(
      false
    );

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
  const getProgressiveFamily = usePGliteSchemaFamily(
    supplierContinuationSchema
  );
  let progressive: ProgressiveBatchOnlyPGliteDriver | undefined;
  let progressiveClient: any;
  const openProgressive = async () => {
    if (!progressiveClient) {
      const family = getProgressiveFamily();
      // An EXTRA driver over the family's database must name the schema the
      // family provisioned, or it addresses `public`, where this suite has no
      // tables.
      progressive = new ProgressiveBatchOnlyPGliteDriver({
        client: family.database,
        namespace: family.namespace,
      });
      progressiveClient = createClient({
        schema: supplierContinuationSchema,
        driver: progressive,
      }) as any;
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
   * The other half of E4, and the honest shape of it: a capacity boundary the
   * composition's own placement cannot clear is answered BEFORE any effect.
   *
   * The retired engine spent one owner on this — `progressiveSeriesRefusal`, asserted
   * by `runProgressiveFragmentOperation` ahead of `executeProgressiveFragment`. Those
   * three names are gone. Raptor 3 keeps the property and drops the owner: a statement
   * is checked against the driver's verified bound-value limit as it is materialized,
   * so a composition whose indivisible statement does not fit refuses before its first
   * batch is submitted. The two assertions after the message are the claim — no batch
   * reached the driver, and the supplier's row does not exist.
   *
   * MEASURED, and recorded rather than contrived: the "cannot re-pin the complete
   * parent row key" reason is NOT reachable through this composition. The enclosing
   * update's own locate publishes the parent's complete row key, so the placement
   * always has row-key members to guard with — including when the root SET moves a
   * non-primary-key referenced value, which was tried and produced a guarded plan (and
   * then an ordinary foreign-key violation, a database fact about the payload rather
   * than a boundary refusal).
   */
  // N5 class D: pinned the retired `progressiveSeriesRefusal` wording; the shipped
  // pre-effect owner is `assertStatementBindParameterCapacity`.
  test("routes the composition's placement through the pre-effect capacity refusal", async () => {
    const family = getProgressiveFamily();
    const cramped = new ProgressiveBatchOnlyPGliteDriver({
      client: family.database,
      namespace: family.namespace,
    });
    const client = createClient({
      schema: supplierContinuationSchema,
      driver: cramped,
    }) as any;
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
    expect(refusal.message).toMatch(CAPACITY_REFUSAL);
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
  const getNonPkFamily = usePGliteSchemaFamily(nonPkSupplierSchema);

  test("a reused non-PK reference cannot redirect the continuation", async () => {
    const family = getNonPkFamily();
    const database = family.database;
    // Both drivers below are EXTRA drivers over the family's database, so both
    // must name the schema it provisioned.
    const namespace = family.namespace;
    const progressive = new ProgressiveBatchOnlyPGliteDriver({
      client: database,
      namespace,
    });
    const client = createClient({
      schema: nonPkSupplierSchema,
      driver: progressive,
    }) as any;
    const concurrent = createClient({
      schema: nonPkSupplierSchema,
      driver: new PGliteDriver({ client: database, namespace }),
    }) as any;
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
