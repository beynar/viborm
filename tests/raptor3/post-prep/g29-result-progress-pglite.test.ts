import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryResult } from "@drivers";
import { QueryEngineError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe, it } from "vitest";

class CorruptingBatchPGliteDriver extends BatchOnlyPGliteDriver {
  insertBatches = 0;
  corrupted = false;
  private corruptionArmed = false;

  resetAndArm(): void {
    this.insertBatches = 0;
    this.corrupted = false;
    this.corruptionArmed = true;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await super.executeBatch<T>(client, queries);
    if (queries.some(({ sql }) => /^INSERT\b/.test(sql))) {
      this.insertBatches++;
    }
    if (!this.corruptionArmed) return responses;

    for (const [index, query] of queries.entries()) {
      if (!/^SELECT\b/.test(query.sql)) continue;
      const response = responses[index];
      assert(response);
      for (const row of response.rows) {
        if (!isRecord(row) || !Object.hasOwn(row, "id")) continue;
        Reflect.set(row, "id", "not-an-integer");
        this.corrupted = true;
      }
    }
    return responses;
  }
}

function failureObservation(failure: unknown): object {
  if (failure instanceof QueryEngineError) {
    return {
      name: failure.name,
      code: failure.code,
      message: failure.message,
      meta: failure.meta,
    };
  }
  if (failure instanceof Error) {
    return { name: failure.name, message: failure.message };
  }
  return { thrown: String(failure) };
}

describe("G2.9 generated-result continuation progress [commands]", () => {
  it("preserves malformed generated-id translation after one committed segment", async () => {
    const database = new PGlite();
    const driver = new CorruptingBatchPGliteDriver({ client: database });
    driver.adapter.capabilities.supportsCteWithMutations = false;
    const entity = s
      .model({ id: s.int().id().increment(), label: s.string() })
      .map("g29_continuation_result");
    const schema = { entity };
    const client = createClient({ schema, driver });
    const migration = await syncLiveSchema(client);
    assert.equal(migration.applied, true);

    try {
      driver.resetAndArm();
      let value: unknown;
      let failure: unknown;
      try {
        value = await createCommandEngine({ schema, driver }).execute(
          "entity",
          "create",
          { data: { label: "written" } }
        );
      } catch (caught) {
        failure = caught;
      }

      const state = await database.query(
        "SELECT id,label FROM g29_continuation_result ORDER BY id"
      );
      const diagnostic = JSON.stringify(
        {
          profile: "pglite-atomic-batch-generated-continuation",
          engine: "commands",
          insertBatches: driver.insertBatches,
          corrupted: driver.corrupted,
          finalDatabase: state.rows,
          value,
          failure: failureObservation(failure),
        },
        undefined,
        2
      );

      assert.equal(value, undefined, diagnostic);
      assert.equal(driver.insertBatches, 1, diagnostic);
      assert.equal(driver.corrupted, true, diagnostic);
      assert(failure instanceof QueryEngineError, diagnostic);
      assert.equal(failure.code, VibORMErrorCode.INTERNAL_ERROR, diagnostic);
      assert.equal(
        failure.message,
        'Driver "pglite" returned a malformed int scalar for operation "create": the value is not a canonical integer.',
        diagnostic
      );
      assert.deepEqual(
        { ...failure.meta },
        {
          driver: "pglite",
          operation: "create",
          scalarType: "int",
          recordSeriesProgress: {
            atomicity: "segment",
            phase: "result",
            committedSegments: 1,
            committedWriteMembers: 1,
            completedMembers: 0,
          },
        },
        diagnostic
      );
      assert.deepEqual(state.rows, [{ id: 1, label: "written" }], diagnostic);
    } finally {
      await client.$disconnect();
      await database.close();
    }
  });
});
