import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertG3GeneratedBatchReceipt,
  captureRaptor3Identity,
  G3_GENERATED_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import { runG3SQLiteBatch } from "./sqlite-campaign";

it("executes one complete G3 SQLite seed batch", async () => {
  // Run alone, with no runner to hand it a batch, it runs its campaign's first.
  const firstSeed = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED ??
      G3_GENERATED_CAMPAIGN.firstSeed
  );
  const seedCount = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_SEED_COUNT ??
      G3_GENERATED_CAMPAIGN.batchSize
  );
  assert(Number.isInteger(firstSeed), "Missing generated G3 first seed");
  const { receipt } = await runG3SQLiteBatch(firstSeed, seedCount);
  assertG3GeneratedBatchReceipt(
    receipt,
    firstSeed,
    G3_GENERATED_CAMPAIGN,
    captureRaptor3Identity()
  );
});
