/**
 * G4 write-envelope campaign, transport lane — one child, one contiguous slice.
 *
 * The scripted returning transports are where a write's acknowledgement and
 * row ownership are decided, which is exactly the boundary G4's envelope rule
 * moved. Same generator, same runner, same receipt assertion as G3; only
 * `G4_WRITE_TRANSPORT_CAMPAIGN` — first seed 100000, 25,000 IDs, disjoint from
 * every other lane — belongs to this milestone.
 *
 * Registered as `g4-write-transport-seeds` /
 * `g4-write-transport-seed-batch <first-seed>`.
 */
import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertG3GeneratedBatchReceipt,
  captureRaptor3Identity,
  G4_WRITE_TRANSPORT_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import { runG3TransportBatch } from "../../g3/generation/transport-campaign";

it("executes one complete G4 write-envelope transport seed batch", async () => {
  const firstSeed = Number(process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED);
  assert(Number.isInteger(firstSeed), "Missing generated G4 write first seed");
  // The child holds the frozen batch, never an ambient count — see the SQLite
  // lane's child for the failure this closes.
  const { receipt } = await runG3TransportBatch(
    firstSeed,
    G4_WRITE_TRANSPORT_CAMPAIGN.batchSize,
    G4_WRITE_TRANSPORT_CAMPAIGN
  );
  assertG3GeneratedBatchReceipt(
    receipt,
    firstSeed,
    G4_WRITE_TRANSPORT_CAMPAIGN,
    captureRaptor3Identity()
  );
});
