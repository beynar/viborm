import { afterAll, describe, it } from "vitest";
import {
  pgStalenessIds,
  runPgStalenessScenario,
  savePgStalenessEvidence,
} from "./staleness-live-pg";

afterAll(savePgStalenessEvidence);
describe("G2 PostgreSQL native staleness: legacy classification", () => {
  for (const id of pgStalenessIds) {
    it(id, async () => {
      await runPgStalenessScenario(id);
    }, 30_000);
  }
});
