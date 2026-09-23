import assert from "node:assert/strict";
import { afterAll, describe, it } from "vitest";
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

describe(`G2 live ${keyLiveProvider} key transitions: independent legacy`, () => {
  for (const scenario of keyTransitionScenarios) {
    it(scenario.id, async () => {
      await runLiveKeyScenario(scenario);
    }, 30_000);
  }
});
