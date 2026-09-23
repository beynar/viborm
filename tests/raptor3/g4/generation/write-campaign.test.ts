/**
 * G4 write-envelope campaign, SQLite lane — one child, one contiguous slice.
 *
 * The subject is the G4 candidate's WRITE envelope, so nothing here is new
 * except the seeds. The recipe generator, the scenarios, the SQLite world, the
 * replay and the receipt assertion are G3's, unchanged; only
 * `G4_WRITE_CAMPAIGN` — first seed 75000, 25,000 IDs — is this milestone's,
 * and it is data. A cell that quietly stopped injecting its fault, dropped its
 * second actor or rotated a different contract family fails
 * `assertG3GeneratedBatchReceipt`, which re-derives all three from the seed.
 *
 * Registered as `g4-write-seeds` / `g4-write-seed-batch <first-seed>`.
 */
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertG3GeneratedBatchReceipt,
  captureRaptor3Identity,
  G4_WRITE_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import { runG3SQLiteBatch } from "../../g3/generation/sqlite-campaign";

it("executes one complete G4 write-envelope SQLite seed batch", async () => {
  const firstSeed = Number(process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED);
  assert(Number.isInteger(firstSeed), "Missing generated G4 write first seed");
  // The child holds the frozen batch, never the ambient seed-count variable
  // that `scripts/run-raptor3.mjs` now deletes from every child environment.
  // Reading it used to shrink this child, and the receipt assertion admits a
  // short batch BY DESIGN (G3's contract, pinned in
  // `scripts/raptor3-campaign-receipts.test.mjs`), so a 1-seed child of a
  // 250-child parent printed "campaign verified" over 1% of its seeds.
  const { receipt } = await runG3SQLiteBatch(
    firstSeed,
    G4_WRITE_CAMPAIGN.batchSize,
    G4_WRITE_CAMPAIGN
  );
  assertG3GeneratedBatchReceipt(
    receipt,
    firstSeed,
    G4_WRITE_CAMPAIGN,
    captureRaptor3Identity()
  );
});
