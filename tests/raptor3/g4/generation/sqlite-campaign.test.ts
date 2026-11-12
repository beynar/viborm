import assert from "node:assert/strict";
import { it } from "vitest";
import {
  assertG4GeneratedBatchReceipt,
  assertG4OracleValidationReceipt,
  captureRaptor3Identity,
  G4_GENERATED_CAMPAIGN,
} from "../../../../scripts/raptor3-manifest.mjs";
import { runG4Batch } from "./campaign";

it("executes one complete G4 SQLite read seed batch", async () => {
  // Run alone, with no runner to hand it a batch, it runs its campaign's first.
  const firstSeed = Number(
    process.env.VIBORM_RAPTOR3_GENERATED_FIRST_SEED ??
      G4_GENERATED_CAMPAIGN.firstSeed
  );
  assert(Number.isInteger(firstSeed), "Missing generated G4 first seed");
  // The child holds the frozen batch, never an ambient count, and its subject
  // is the runner's: `scripts/run-raptor3.mjs` deletes any inherited
  // VIBORM_RAPTOR3_G4_SUBJECT and writes the one the command asked for. Run
  // alone, the subject is the engine; an unknown value is a harness failure.
  const subject = process.env.VIBORM_RAPTOR3_G4_SUBJECT ?? "candidate";
  assert(
    subject === "candidate" || subject === "shipped",
    "The runner must name the G4 campaign subject"
  );
  const { receipt } = await runG4Batch(
    firstSeed,
    G4_GENERATED_CAMPAIGN.batchSize,
    G4_GENERATED_CAMPAIGN,
    subject
  );
  const identity = captureRaptor3Identity();
  if (subject === "shipped")
    assertG4OracleValidationReceipt(
      receipt,
      firstSeed,
      G4_GENERATED_CAMPAIGN,
      identity
    );
  else
    assertG4GeneratedBatchReceipt(
      receipt,
      firstSeed,
      G4_GENERATED_CAMPAIGN,
      identity
    );
});
