import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { describe, it } from "vitest";
import { captureRaptor3Identity } from "../../scripts/raptor3-manifest.mjs";
import { assertEquivalentRunObservations } from "../../benchmarks/operation-pipeline-semantics.mjs";
import type { FailureObservation } from "./harness/protocol";
import {
  encodeReplayRecords,
  replayG0Run,
  verifyG0Pair,
} from "./harness/replay";
import { runSQLiteWorld } from "./harness/sqlite-world";
import { G0_PROFILES, type ProfileId } from "./profiles";
import { fixedScenarios } from "./scenarios/contracts";

const scenario = fixedScenarios.find(
  (scenario) => scenario.id === "s1-parent-rollback"
)!;

function assertNativeCleanup(
  aggregate: FailureObservation,
  profile: ProfileId
): void {
  assert.equal(aggregate.name, "AggregateError");
  assert.deepEqual(Object.keys(aggregate).sort(), [
    "cause",
    "errors",
    "message",
    "name",
  ]);
  const primary = aggregate.cause as FailureObservation;
  const interactive = profile === "sqlite-interactive";
  assert.equal(
    primary.name,
    interactive ? "UniqueConstraintError" : "SqliteError"
  );
  assert.equal(
    primary.code,
    interactive ? "V3001" : "SQLITE_CONSTRAINT_PRIMARYKEY"
  );
  assert.equal(
    primary.message,
    interactive
      ? "Unique constraint violation"
      : "UNIQUE constraint failed: s1_children.id"
  );
  assert.equal(aggregate.message, primary.message);
  assert.deepEqual(aggregate.errors, [
    primary,
    { name: "Error", message: "Controlled failure after rollback" },
  ]);
}

describe.each(G0_PROFILES)("G1 C10 real rollback cleanup: %s", (profile) => {
  it("retains the actual write failure and ordered cleanup evidence", async () => {
    const fault = { kind: "after-rollback" } as const;
    const baseline = await runSQLiteWorld(scenario, profile, 0, { fault });
    const candidate = await runSQLiteWorld(scenario, profile, 0, {
      fault,
      candidateFactory: createCommandEngine,
      candidateName: "commands",
    });
    const directory = process.env.VIBORM_RAPTOR3_EVIDENCE_DIRECTORY;
    if (directory)
      await writeFile(
        join(directory, `cleanup-${profile}-corpus.json`),
        JSON.stringify({
          formatVersion: 1,
          identity: captureRaptor3Identity(),
          records: encodeReplayRecords([baseline.record, candidate.record]),
        })
      );
    if (profile === "sqlite-interactive") {
      for (const world of [baseline, candidate])
        world.fixture.assert(world.observation);
      // These are the proven lifecycle report's two actual errors, not arbitrary
      // nested causes. The existing comparator may rename each error's own ID;
      // the full oracle above pins their shared identity and ordered envelope.
      for (const index of [0, 1]) {
        const observations = [baseline, candidate].map(({ observation }) => {
          assert(observation.outcome.kind === "failure");
          return {
            ...observation,
            outcome: {
              kind: "failure" as const,
              failure: observation.outcome.failure.errors![
                index
              ] as FailureObservation,
            },
          };
        });
        assertEquivalentRunObservations(
          `C10 lifecycle error ${index}`,
          observations[0]!,
          observations[1]!
        );
      }
    } else verifyG0Pair(baseline, candidate);

    for (const world of [baseline, candidate]) {
      const events = world.record.tape.events;
      const injected = events.findIndex(
        (event) =>
          event.kind === "injected-failure" && event.cut === "after-rollback"
      );
      assert.deepEqual(events[injected - 1], {
        kind: "transaction",
        phase: "rollback",
      });
      assert(
        events
          .slice(0, injected)
          .some((event) => event.kind === "dispatch-failure"),
        "Cleanup must follow a real provider write failure"
      );
      assert(
        !events.some(
          (event) => event.kind === "transaction" && event.phase === "commit"
        )
      );

      const cleanupEvents = events.filter(
        (event) => event.kind === "cleanup-failure"
      );
      assert.equal(cleanupEvents.length, 1);
      const cleanup = cleanupEvents[0]!;
      assertNativeCleanup(cleanup.failure, profile);

      for (const corruption of ["drop-secondary", "replace-primary"] as const) {
        const aggregate = structuredClone(cleanup.failure);
        if (corruption === "drop-secondary")
          aggregate.errors = aggregate.errors!.slice(0, 1);
        else aggregate.errors = [...aggregate.errors!].reverse();
        assert.throws(
          () => assertNativeCleanup(aggregate, profile),
          corruption
        );
      }
    }
    await replayG0Run(baseline.record);
    for (let replay = 0; replay < 3; replay += 1)
      await replayG0Run(candidate.record);
  });
});
