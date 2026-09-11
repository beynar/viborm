import { createCommandEngine } from "@query-engine/raptor3/commands";
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
      await runPolishRecovery(id, createCommandEngine);
    }, 30_000);
  }
});
