import { afterAll, describe, it } from "vitest";
import {
  cleanupRecoveryId,
  runUniqueRaceScenario,
  saveUniqueRaceEvidence,
} from "./unique-races-live";

afterAll(saveUniqueRaceEvidence);
describe("G2 PostgreSQL native rollback recovery boundary: legacy", () => {
  it(cleanupRecoveryId, async () => {
    await runUniqueRaceScenario(cleanupRecoveryId);
  }, 30_000);
});
