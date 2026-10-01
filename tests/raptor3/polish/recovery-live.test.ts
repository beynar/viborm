import { createTestCommandEngine } from "@tests/raptor3/harness/command-engine";
import { afterAll, describe, it } from "vitest";
import {
  polishRecoveryIds,
  runPolishRecovery,
  savePolishRecoveryEvidence,
} from "./recovery-live";

afterAll(savePolishRecoveryEvidence);
// Qualification preserves private G2 recovery; the shipped engine has different
// collision timing and attempts another INSERT when the recovery winner is lost.
describe("G2.5 selected-engine INSERT recovery observations: PostgreSQL", () => {
  for (const id of polishRecoveryIds) {
    it(id, async () => {
      await runPolishRecovery(id, createTestCommandEngine);
    }, 30_000);
  }
});
