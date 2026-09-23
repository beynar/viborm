import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { QueryEngineError, VibORMErrorCode } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { isRecord } from "@validation/value-guards";
import { PGlite, type Transaction } from "@electric-sql/pglite";
import { describe, it } from "vitest";

const INSERT_STATEMENT = /^INSERT\b/;

class CorruptingBatchPGliteDriver extends BatchOnlyPGliteDriver {
  insertStatements = 0;
  insertBatches = 0;
  corrupted = false;
  private corruptionArmed = false;

  resetAndArm(): void {
    this.insertStatements = 0;
    this.insertBatches = 0;
    this.corrupted = false;
    this.corruptionArmed = true;
  }

  /**
   * The cut is stated over ANY row-bearing response on ANY transport, not over
   * `^SELECT` only and not over the batch entry only: both the statement that
   * carries the generated row and the transport that carries that statement are
   * physical choices. A scalar-only root `create` folds to one
   * `INSERT … RETURNING`, and since Arnaud's D-7 decision a lone statement
   * leaves the batch, so a `^SELECT`-only or `executeBatch`-only cut would be
   * ELIMINATED by the fold and this specimen would silently stop witnessing
   * (raptor3 plan §5.4). This driver's batch entry dispatches every query
   * through `execute`, so the one override below covers both transports.
   */
  protected override async execute<T>(
    client: PGlite | Transaction,
    sql: string,
    params: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    const response = await super.execute<T>(client, sql, params, context);
    if (INSERT_STATEMENT.test(sql)) this.insertStatements++;
    if (!this.corruptionArmed) return response;
    for (const row of response.rows) {
      if (!isRecord(row) || !Object.hasOwn(row, "id")) continue;
      Reflect.set(row, "id", "not-an-integer");
      this.corrupted = true;
    }
    return response;
  }

  protected override async executeBatch<T>(
    client: PGlite | Transaction,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    const responses = await super.executeBatch<T>(client, queries);
    if (queries.some(({ sql }) => INSERT_STATEMENT.test(sql))) {
      this.insertBatches++;
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

describe("G2.9 generated-result progress [commands]", () => {
  /**
   * A root single-record write with a GENERATED identity is ONE
   * `INSERT … RETURNING` on a provider that carries RETURNING, so after D-7 it
   * is the operation's only statement and needs no batch envelope. Its truthful
   * answer is therefore the shipped one: the malformed-scalar refusal with
   * `{driver, operation, scalarType}` and no record series to report on
   * (`write-engine/OperationExecutor.ts` `runBorrowedStatementAtomic`). The
   * committed-segment progress this file used to pin now belongs to the shape
   * that still has a record series, pinned on the same transport at
   * `tests/raptor3/g4/unit02/lone-statement-transport.test.ts`.
   */
  it("preserves malformed generated-id translation on the statement the fold uses", async () => {
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
          insertStatements: driver.insertStatements,
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
      assert.equal(driver.insertStatements, 1, diagnostic);
      // D-7 (Arnaud, 2026-09-15): the lone statement leaves the batch, exactly
      // as the shipped `runStatementAtomic` sends it.
      assert.equal(driver.insertBatches, 0, diagnostic);
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
        { driver: "pglite", operation: "create", scalarType: "int" },
        diagnostic
      );
      assert.deepEqual(state.rows, [{ id: 1, label: "written" }], diagnostic);
    } finally {
      await client.$disconnect();
      await database.close();
    }
  });
});
