import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import {
  dynamicRecoveryId,
  runDynamicRecoveryBoundary,
  saveRecoveryBoundaryEvidence,
} from "./recovery-boundaries-live";
import {
  cleanupRecoveryId,
  runUniqueRaceScenario,
  saveUniqueRaceEvidence,
} from "./unique-races-live";

afterAll(saveRecoveryBoundaryEvidence);
afterAll(saveUniqueRaceEvidence);
describe("G2 PostgreSQL atomic recovery admission boundary: commands", () => {
  it(dynamicRecoveryId, async () => {
    await runDynamicRecoveryBoundary(createCommandEngine);
  }, 30_000);
  it(cleanupRecoveryId, async () => {
    const baseline = await runUniqueRaceScenario(cleanupRecoveryId);
    const candidate = await runUniqueRaceScenario(
      cleanupRecoveryId,
      createCommandEngine
    );
    assertEquivalentRunObservations(
      cleanupRecoveryId,
      baseline.observation,
      candidate.observation
    );
  }, 30_000);
});
