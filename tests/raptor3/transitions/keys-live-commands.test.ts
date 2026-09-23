import assert from "node:assert/strict";
import { createCommandEngine } from "@query-engine/raptor3/commands";
import { afterAll, describe, it } from "vitest";
import { assertEquivalentRunObservations } from "../../../benchmarks/operation-pipeline-semantics.mjs";
import { G2_KEY_CASE_IDS } from "../contracts";
import { keyTransitionScenarios } from "./keys";
import {
  keyLiveProvider,
  runLiveKeyScenario,
  saveLiveKeyEvidence,
} from "./keys-live";

afterAll(saveLiveKeyEvidence);

assert.deepEqual(
  keyTransitionScenarios.map((scenario) => scenario.id),
  G2_KEY_CASE_IDS
);

describe(`G2 live ${keyLiveProvider} key transitions: commands`, () => {
  for (const scenario of keyTransitionScenarios) {
    it(scenario.id, async () => {
      const baseline = await runLiveKeyScenario(scenario);
      const candidate = await runLiveKeyScenario(scenario, createCommandEngine);
      assertEquivalentRunObservations(
        scenario.id,
        baseline.observation,
        candidate.observation
      );
    }, 30_000);
  }
});
