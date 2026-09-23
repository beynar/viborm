/**
 * N5 — a premise stated BEHIND the unit's own writes is not re-probed.
 *
 * When a batch aborts at a premise and the transport cannot say WHICH statement
 * failed, the ladder re-probes the registered assertions to attribute the
 * failure. An ordered observation's requirement (N1) is stated over the batch
 * reference scratch, which the rolled-back transaction took with it, so that
 * one premise cannot be asked again at all: the statement would raise an
 * undefined-table error where the ladder owes an attribution.
 *
 * The shipped rule is about THAT premise and no other. The ladder skips
 * exactly the premise that binds the batch reference scratch
 * (`AssertedPremise.readsBatchReference`) and re-probes every other one,
 * wherever it stands; the positional inference — "exactly one premise stands
 * behind the writes, so it is the one the re-probe could not clear" — answers
 * only when that is the shape. Position is not the fact: a unit that states
 * two premises behind its first write keeps the correlated identity of the one
 * the re-probe contradicts, which is the sibling N1 cell in
 * `ordered-observation.test.ts` and what falsifying this file by restoring
 * wave 2a's positional skip turns red.
 *
 * The gate cell this closes is
 * `tests/contracts/engine/query/relation-key-update-legality-occupied-to-one.test.ts`
 * "reports not-found for an empty setNull child-held UPDATE under a PK
 * transition", where the re-probe's own `42P01` escaped `submit` and replaced
 * the attribution with `QueryError: Query execution failed`.
 */

import assert from "node:assert/strict";
import { createClient } from "@client/client";
import type { BatchQuery, QueryExecutionContext, QueryResult } from "@drivers";
import { NestedWriteError } from "@errors";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import type Database from "better-sqlite3";
import { afterEach, describe, it } from "vitest";
import { NoIndexBatchOnlyDriver } from "./batch-only-drivers";

const parent = s
  .model({
    id: s.int().id(),
    name: s.string(),
    child: s.toOne(() => child),
  })
  .map("n5bp_parents");
const child = s
  .model({
    id: s.int().id(),
    label: s.string(),
    parentId: s.int().nullable(),
    parent: s
      .toOne(() => parent)
      .fields("parentId")
      .references("id")
      .onUpdate("setNull"),
  })
  .map("n5bp_children");
const schema = { child, parent };

const SCRATCH = "__viborm_batch_refs";

/** Every statement dispatched on its own AFTER a batch aborted. */
class ReprobeRecordingDriver extends NoIndexBatchOnlyDriver {
  readonly afterAbort: string[] = [];
  private aborted = false;
  protected override async execute<T>(
    client: Database.Database,
    statement: string,
    parameters: unknown[],
    context?: QueryExecutionContext
  ): Promise<QueryResult<T>> {
    if (this.aborted) this.afterAbort.push(statement);
    return super.execute<T>(client, statement, parameters, context);
  }
  protected override async executeBatch<T>(
    client: Database.Database,
    queries: BatchQuery[]
  ): Promise<QueryResult<T>[]> {
    try {
      return await super.executeBatch<T>(client, queries);
    } catch (error) {
      this.aborted = true;
      throw error;
    }
  }
}

describe("N5: the ladder's blind premise", () => {
  let driver: ReprobeRecordingDriver;
  afterEach(async () => {
    await driver?.disconnect();
  });

  it("attributes the empty slot without re-probing the batch scratch", async () => {
    driver = new ReprobeRecordingDriver();
    const client = createClient({ schema, driver });
    await syncLiveSchema(client);
    await client.parent.create({ data: { id: 1, name: "Parent" } });
    driver.reset();

    // The root moves its own key, so the nested lookup is an ORDERED
    // OBSERVATION taken behind that write — its requirement is the premise the
    // rollback hides. The slot is empty, so that premise is the one that fails.
    const failure = await client.parent
      .update({
        where: { id: 1 },
        data: { id: { increment: 1 }, child: { update: { label: "x" } } },
      })
      .then(
        () => undefined,
        (error: unknown) => error
      );

    assert.ok(
      failure instanceof NestedWriteError,
      `the correlated refusal, not the re-probe's own error: ${String(failure)}`
    );
    assert.equal(
      failure.message,
      "Cannot update relation 'child': target record was not found for this parent."
    );
    assert.deepEqual(
      driver.afterAbort.filter((statement) => statement.includes(SCRATCH)),
      [],
      "no premise stated over the batch scratch is re-probed after the rollback"
    );
    assert.deepEqual(await client.child.findMany(), []);
    assert.deepEqual(await client.parent.findMany({ select: { id: true } }), [
      { id: 1 },
    ]);
  });
});
