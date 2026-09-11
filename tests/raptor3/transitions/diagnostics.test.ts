import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readSuppressedFailures } from "@drivers/shared/suppressed-failure";
import { QueryError } from "@errors";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import { encodeEvidenceValue } from "../../../benchmarks/operation-pipeline-evidence.mjs";
import {
  assertRaptor3Identity,
  captureRaptor3Identity,
} from "../../../scripts/raptor3-manifest.mjs";
import type { ScenarioDefinition } from "../harness/protocol";
import { selectRaptor3EvidenceDirectory } from "../harness/evidence-directory";
import { encodeReplayRecords } from "../harness/replay";
import { observeFailure, runSQLiteWorld } from "../harness/sqlite-world";
import { capturedKeyScenarios } from "./staleness";

const source = capturedKeyScenarios.find(
  (scenario) => scenario.id === "g2-key-captured-restored"
);
assert(source, "Missing restored captured-key witness");
const restoredCut = "captured-key-restored-after-rollback";
const diagnosticCut = "diagnostic-read-after-restoration";
const expectedState = {
  counters: [
    { id: 10, tag: "selected" },
    { id: 15, tag: "final-key-decoy" },
    { id: 10000, tag: "untouched" },
  ],
  ticks: [{ id: "decoy-tick", counterId: 10000 }],
};

async function recordDisputedLoss(engine: "legacy" | "commands") {
  const identity = captureRaptor3Identity();
  let caught: unknown;
  const scenario: ScenarioDefinition = {
    ...source!,
    prepare(controls) {
      const fixture = source!.prepare(controls);
      let diagnosticPending = false;
      return {
        ...fixture,
        afterTransaction(database, phase) {
          const cut = fixture.afterTransaction?.(database, phase);
          if (cut === restoredCut) diagnosticPending = true;
          return cut;
        },
        afterStatement(database, completion) {
          const cut = fixture.afterStatement?.(database, completion);
          if (!diagnosticPending) return cut;
          diagnosticPending = false;
          return diagnosticCut;
        },
        async invoke(driver, candidateFactory) {
          try {
            return await fixture.invoke(driver, candidateFactory);
          } catch (failure) {
            caught = failure;
            throw failure;
          }
        },
      };
    },
  };
  const world = await runSQLiteWorld(scenario, "sqlite-atomic-batch", 0, {
    fault: { kind: "at-cut", cut: diagnosticCut },
    ...(engine === "commands"
      ? {
          candidateFactory: createCommandEngine,
          candidateName: "commands" as const,
        }
      : {}),
  });
  assert(caught instanceof Error, "The actual public invocation must reject");
  const failure = observeFailure(caught);
  const suppressed = readSuppressedFailures(caught).map(observeFailure);
  const directory = await selectRaptor3EvidenceDirectory(
    "viborm-raptor3-g2-diagnostic-dispute-"
  );
  assertRaptor3Identity(identity);
  // Save before the disputed expectation: a changed outcome must retain its evidence.
  await writeFile(
    join(directory, `g2-diagnostic-dispute-${engine}.json`),
    JSON.stringify({
      formatVersion: 1,
      identity,
      status: "disputed-current-behavior",
      engine,
      claim:
        "Diagnostic failure replaces the primary batch failure; this is not G2 acceptance",
      replayExpectation:
        "The normal no-fault fixture oracle rejects this lost-primary outcome",
      records: encodeReplayRecords([world.record]),
      caught: encodeEvidenceValue(failure),
      suppressed: encodeEvidenceValue(suppressed),
    })
  );

  // This controlled diagnostic fault has its own oracle; the no-fault oracle is not applicable.
  assert.deepEqual(world.observation.initial, expectedState);
  assert.deepEqual(world.observation.final, expectedState);
  assert.deepEqual(world.observation.defaults, []);
  assert.deepEqual(world.observation.reachedCuts, [
    "captured-key-moved",
    restoredCut,
    diagnosticCut,
  ]);
  const events = world.record.tape.events;
  const primary = events.find((event) => event.kind === "dispatch-failure");
  assert(primary, "A real provider assertion must fail before diagnostics");
  assert.equal(primary.failure.code, "SQLITE_ERROR");
  assert.equal(primary.failure.message, "malformed JSON");
  const rollbackIndex = events.findIndex(
    (event) => event.kind === "transaction" && event.phase === "rollback"
  );
  const restoredIndex = events.findIndex(
    (event) => event.kind === "cut" && event.name === restoredCut
  );
  const injectedIndex = events.findIndex(
    (event) => event.kind === "injected-failure" && event.cut === diagnosticCut
  );
  assert(
    events.indexOf(primary) < rollbackIndex &&
      rollbackIndex < restoredIndex &&
      restoredIndex < injectedIndex,
    "The diagnostic fault must follow the primary, real rollback and external restoration"
  );
  assert.equal(
    events
      .slice(restoredIndex + 1, injectedIndex)
      .filter((event) => event.kind === "completion").length,
    1,
    "Inject on the first actual diagnostic completion"
  );
  assert.equal(
    events.filter((event) => event.kind === "injected-failure").length,
    1
  );

  // These pins document the defect until the disputed contract row is adjudicated.
  assert(caught instanceof QueryError);
  assert.equal(failure.name, "QueryError");
  assert.equal(failure.code, "V2001");
  assert.equal(failure.message, "Query execution failed");
  assert.deepEqual(failure.cause, {
    name: "Error",
    message: "Underlying error details redacted",
  });
  assert.deepEqual(
    suppressed,
    [],
    "Current behavior loses the primary without canonical secondary evidence"
  );
  assert.deepEqual(world.observation.outcome, { kind: "failure", failure });
}

describe("G2 disputed diagnostic failure — reproducer, not acceptance", () => {
  it("records legacy loss of the primary after a diagnostic read fails", async () => {
    await recordDisputedLoss("legacy");
  });

  it("records current candidate parity with legacy primary loss, pending adjudication", async () => {
    await recordDisputedLoss("commands");
  });
});
