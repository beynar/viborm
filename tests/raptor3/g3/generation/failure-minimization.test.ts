import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { it } from "vitest";
import type { G0ReplayRecord } from "../../harness/protocol";
import { replayG0Run } from "../../harness/replay";
import { runSQLiteWorld } from "../../harness/sqlite-world";
import { generatedBulkScenario } from "./bulk-scenario";
import { minimizeG3Failure } from "./failure-minimization";
import { g3RecipeFromPublicInput, type G3GeneratedRecipe } from "./recipe";

const padded = g3RecipeFromPublicInput({
  recipe: {
    seed: 8000,
    contract: "C08",
    actors: 2,
    operations: 32,
    fault: "none",
    verb: "createMany",
    presentation: "select",
    rowCount: 8,
    limit: 0,
  },
});

async function executeWrongWorld(
  recipe: G3GeneratedRecipe,
  captureRecord: (record: G0ReplayRecord) => void
) {
  assert.equal(recipe.contract, "C08");
  if (recipe.contract !== "C08") throw new Error("Unreachable G3 recipe");
  const world = await runSQLiteWorld(
    generatedBulkScenario(recipe, { specimen: "wrong-g3-stored-state" }),
    "sqlite-interactive",
    recipe.seed,
    { candidateFactory: createCommandEngine, candidateName: "commands" }
  );
  captureRecord(world.record);
  world.fixture.assert(world.observation);
}

it("preserves, shrinks, and exactly replays a real wrong-world C08 failure", async () => {
  const original = structuredClone(padded);
  let originalRecord: G0ReplayRecord | undefined;
  let originalFailure: unknown;
  try {
    await executeWrongWorld(padded, (record) => {
      originalRecord = record;
    });
  } catch (failure) {
    originalFailure = failure;
  }
  assert(originalRecord, "The padded wrong-world run did not produce a record");
  assert(originalFailure, "The padded wrong-world specimen did not fail");
  assert.match(String(originalFailure), /g3-c08:stored-state/);
  const minimized = await minimizeG3Failure<G0ReplayRecord>(
    padded,
    "sqlite-interactive",
    originalFailure,
    executeWrongWorld,
    replayG0Run,
    3
  );
  assert.equal(minimized.status, "minimized");
  assert("identity" in minimized);
  assert.deepEqual(padded, original);
  assert.deepEqual(minimized.reduced, {
    ...padded,
    actors: 1,
    operations: 1,
    rowCount: 1,
  });
  assert(minimized.attempts > 0 && minimized.attempts <= 64);
  assert.equal(minimized.replays, 3);
  assert("record" in minimized);
});
