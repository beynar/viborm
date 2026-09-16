/**
 * Review probe — G4 harness reconciliation, the transport-plan fold.
 *
 * `ordinaryRecurrenceReplies` now drops the trailing SELECT when
 * `insertCount === 1`, and `recurrenceSegment` therefore moves `expected` onto
 * the INSERT's own response. The unit's justification is that the candidate
 * "publishes the row from the INSERT's own RETURNING". Nothing in the campaign
 * checks that: the scripted `expected` value is also derivable from the public
 * input, so a candidate that echoed its input instead of reading the provider's
 * row would pass every folded cell.
 *
 * These two cells script the SAME reply shape the plan now writes, but with a
 * provider row the input cannot supply, and with a provider row missing.
 */
import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import { recurrenceOrdinaryWorld } from "../../../g3/generation/recurrence-ordinary-world";
import type { G3GeneratedRecipe } from "../../../g3/generation/recipe";
import { Recorder, recordingEventLimit } from "../../../harness/recorder";
import { ScriptedTransport } from "../../../transport/driver";
import type { Reply } from "../../../transport/driver";

const FOLDED_RECIPE = {
  contract: "C11",
  seed: 8027,
  actors: 1,
  operations: 1,
  fault: "none",
  depth: 0,
  fanout: 0,
  shape: "ordinary",
} as const satisfies Extract<G3GeneratedRecipe, { contract: "C11" }>;

async function runFoldedCreate(responseRows: unknown[]) {
  const world = recurrenceOrdinaryWorld(FOLDED_RECIPE, false);
  const operation = world.operations[0];
  assert.ok(operation);
  const firstParameter = `n-${FOLDED_RECIPE.seed}-0-s0`;
  const reply: Reply = {
    name: "probe:recurrence-0",
    via: "batch",
    // exactly the shape `ordinaryRecurrenceReplies` now scripts for depth 0
    statements: [{ action: "INSERT", parameters: [firstParameter] }],
    committed: true,
    outcome: {
      kind: "rows",
      responses: [{ rows: responseRows, rowCount: responseRows.length }],
    },
  };
  const recorder = new Recorder(
    FOLDED_RECIPE.seed,
    undefined,
    recordingEventLimit("g3-generated-transport")
  );
  let settled: { kind: "success"; value: unknown } | { kind: "failure"; failure: Error };
  let statements: readonly { sql: string }[] = [];
  await recorder.control(async () => {
    const driver = new ScriptedTransport([], recorder, "scripted-returning-weak");
    driver.installScripts([
      { name: "probe", firstParameter, replies: [reply] },
    ]);
    const candidate = createCommandEngine({ schema: world.schema, driver });
    try {
      const work = candidate.execute("node", "create", operation.args);
      const outcome = await driver
        .drain(
          work.then(
            (value) => ({ kind: "success", value }) as const,
            (failure) => ({ kind: "failure", failure: failure as Error }) as const
          ),
          1
        );
      settled = outcome;
      statements = driver.statements;
      driver.finish();
    } finally {
      await driver.disconnect();
    }
  });
  recorder.finish();
  // biome-ignore lint/style/noNonNullAssertion: assigned inside the control block
  return { settled: settled!, statements };
}

describe("review probe: the folded depth-0 root create", () => {
  it("submits exactly one INSERT, which is what the new plan scripts", async () => {
    const { statements } = await runFoldedCreate([
      { id: "provider-chose-this" },
    ]);
    assert.equal(statements.length, 1);
    assert.match(statements[0]!.sql, /^INSERT\b/i);
    assert.match(statements[0]!.sql, /RETURNING/i);
  });

  it("publishes the PROVIDER's returned row, not the public input", async () => {
    const { settled } = await runFoldedCreate([{ id: "provider-chose-this" }]);
    assert.equal(settled.kind, "success");
    if (settled.kind !== "success") return;
    assert.deepEqual(
      settled.value,
      { id: "provider-chose-this" },
      "the fold's §5.4 justification is that the INSERT's own RETURNING is the publication"
    );
  });

  it("treats zero returned rows as the missing branch, which is the fold's replacing invariant", async () => {
    const { settled } = await runFoldedCreate([]);
    assert.equal(
      settled.kind,
      "failure",
      "a folded write that returns no row cannot publish one"
    );
  });
});
