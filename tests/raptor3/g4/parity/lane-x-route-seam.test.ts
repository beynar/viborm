/**
 * Parity lane X — U5.5 and U7 falsifiers, on the planning fixture only.
 *
 * U5.5: an affected-row count is execution semantics. A driver that
 * acknowledges fewer rows than were submitted has not written the request, and
 * the operation refuses instead of publishing the shortfall as its answer.
 *
 * The restored `bulk-create-plan` short-window pin, as a ONE-SIDED pin: the
 * deleted cross-engine cell asserted the deleted engine's own "is unresolved"
 * sentence; what it PROTECTED is that a truncated provider result window raises
 * instead of silently reporting a wrong count. That is this engine's own
 * sentence, asserted against this engine alone.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { QueryExecutionContext, QueryResult } from "@drivers";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { PlanningDriver } from "@tests/fixtures/drivers/planning";
import { describe, it } from "vitest";

const row = s
  .model({
    id: s.int().id().increment(),
    code: s.string().unique(),
    label: s.string(),
  })
  .map("lanex_route_rows");

const schema = { row };

/** Acknowledges a chosen number of rows for every statement it is given. */
class CountingDriver extends PlanningDriver {
  private readonly acknowledged: number;
  constructor(acknowledged: number) {
    super("postgresql", { driverName: "lane-x-counting" });
    this.acknowledged = acknowledged;
  }
  protected override async execute<T>(
    _client: null,
    _sql: string,
    _params: unknown[],
    _context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    return { rows: [], rowCount: this.acknowledged };
  }
}

describe("lane X — route seam and affected-row counts", () => {
  it("refuses a createMany the driver acknowledged short", async () => {
    const driver = new CountingDriver(1);
    const client = createClient({ schema, driver });
    try {
      await assert.rejects(
        async () => {
          await client.row.createMany({
            data: [
              { code: "a", label: "first" },
              { code: "b", label: "second" },
            ],
          });
        },
        (error: unknown) =>
          error instanceof Error &&
          error.message ===
            "Driver 'lane-x-counting' reported 1 of 2 inserted rows for operation 'createMany'."
      );
    } finally {
      await client.$disconnect();
    }
  });

  it("publishes the acknowledged count when it matches the rows submitted", async () => {
    const driver = new CountingDriver(2);
    const client = createClient({ schema, driver });
    try {
      assert.deepEqual(
        await client.row.createMany({
          data: [
            { code: "a", label: "first" },
            { code: "b", label: "second" },
          ],
        }),
        { count: 2 }
      );
    } finally {
      await client.$disconnect();
    }
  });

  it("fails closed on a short provider result window", async () => {
    const driver = new PlanningDriver("postgresql", {
      driverName: "lane-x-window",
      supportsTransactions: false,
      supportsBatch: true,
    });
    const engine = createCommandEngine({ schema, driver });
    const prepared = await engine.prepareBatch("row", "createMany", {
      data: [
        { code: "a", label: "first" },
        { id: 10, code: "b", label: "second" },
      ],
    });
    assert.ok(prepared, "the bulk program was not batch-lowerable");
    assert.equal(prepared.queries.length, 2);
    // One window for two statements: the missing result is refused rather than
    // reported as a smaller count.
    assert.throws(
      () => prepared.parseResult([{ rows: [], rowCount: 1 }]),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          "Driver 'lane-x-window' omitted the prepared result for operation 'createMany'."
    );
  });
});
