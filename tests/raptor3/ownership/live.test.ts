import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { s } from "@schema";
import { describe, it } from "vitest";
import type { LiveFixture } from "../transitions/live-world";
import { liveProvider, runLiveWorld } from "../transitions/live-world";

const record = s
  .model({ id: s.int().id(), label: s.string() })
  .map("g27_native_records");

const fixture: LiveFixture = {
  expectedExecutions: 3,
  initial: { records: [{ id: 1, label: "initial" }] },
  tables: {
    records: { name: "g27_native_records", order: ["id"] },
  },
  async invoke(driver, factory) {
    assert(factory, "The G2.7 native witness requires the candidate");
    const engine = factory({ schema: { record }, driver });
    const rollback = new Error("caller rollback");
    await assert.rejects(
      driver.withTransaction(async (transaction) => {
        await engine.execute(
          "record",
          "update",
          { where: { id: 1 }, data: { label: "must-roll-back" } },
          { kind: "borrowed-transaction", driver: transaction }
        );
        throw rollback;
      }),
      (failure) => failure === rollback
    );
    return driver.withTransaction(async (transaction) => {
      const before = await engine.execute(
        "record",
        "findUnique",
        { where: { id: 1 } },
        { kind: "borrowed-transaction", driver: transaction }
      );
      const after = await engine.execute(
        "record",
        "update",
        {
          where: { id: 1 },
          data: { label: `${liveProvider}-committed` },
          select: { id: true, label: true },
        },
        { kind: "borrowed-transaction", driver: transaction }
      );
      return { before, after };
    });
  },
  assert(observation) {
    assert.deepEqual(observation.outcome, {
      kind: "success",
      value: {
        before: { id: 1, label: "initial" },
        after: { id: 1, label: `${liveProvider}-committed` },
      },
    });
    assert.deepEqual(observation.final, {
      records: [{ id: 1, label: `${liveProvider}-committed` }],
    });
  },
};

describe(`G2.7 native ${liveProvider} borrowed execution`, () => {
  it("runs a read and write through the caller's transaction", async () => {
    const run = await runLiveWorld(
      fixture,
      () => ({
        g27_native_records: "id INTEGER PRIMARY KEY, label TEXT NOT NULL",
      }),
      createCommandEngine
    );

    fixture.assert(run.observation);
    run.assertHealthy();
    assert(run.completions.length >= 3);
    assert(
      run.completions.every((completion) => completion.transactionOpen),
      "every candidate statement must use the transaction-bound connection"
    );
  }, 30_000);
});
