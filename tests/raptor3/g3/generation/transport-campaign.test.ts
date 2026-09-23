import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertG3GeneratedBatchReceipt,
  captureRaptor3Identity,
  G3_GENERATED_TRANSPORT_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import { runG3TransportBatch } from "./transport-campaign";

it("executes one complete G3 transport seed batch", async () => {
  const firstSeed = Number(process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED);
  const seedCount = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_SEED_COUNT ??
      G3_GENERATED_TRANSPORT_CAMPAIGN.batchSize
  );
  assert(Number.isInteger(firstSeed), "Missing generated G3 first seed");
  const { receipt } = await runG3TransportBatch(firstSeed, seedCount);
  assertG3GeneratedBatchReceipt(
    receipt,
    firstSeed,
    G3_GENERATED_TRANSPORT_CAMPAIGN,
    captureRaptor3Identity()
  );
});
