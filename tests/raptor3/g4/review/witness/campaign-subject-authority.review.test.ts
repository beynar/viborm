/**
 * Review probe. Claim under attack: witness note §4 — "`assertG4GeneratedBatchReceipt`
 * requires `subject: "candidate"` … A shipped-subject receipt can never
 * qualify" — presented as the invariant that keeps the oracle-validation lane
 * from becoming evidence for the candidate.
 *
 * The invariant holds inside the receipt assertion. The probe attacks the two
 * seams around it:
 *
 *  1. `scripts/run-raptor3.mjs` chooses WHICH assertion to apply from the
 *     receipt's own `subject` field, and the subject is chosen by an ambient
 *     environment variable the runner never sanitises — unlike every other
 *     `VIBORM_RAPTOR3_*` variable that changes what a child does.
 *  2. Neither `verified.json` written by the runner (per-run at
 *     scripts/run-raptor3.mjs:978, per-campaign at :593) records the subject,
 *     and both success lines read "verified".
 *
 * The executed receipt referenced below was produced by this review with
 * `VIBORM_RAPTOR3_G4_SUBJECT=shipped node scripts/run-raptor3.mjs g4-seed-batch 20000`
 * (exit 0) and is saved under
 * `docs/architecture/raptor3-evidence/g4/witness-review-receipts/subject-leak/`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const RUNNER = readFileSync("scripts/run-raptor3.mjs", "utf8");
const RECEIPTS =
  "docs/architecture/raptor3-evidence/g4/witness-review-receipts/subject-leak";

describe("review probe: who decides a G4 child's subject", () => {
  it("the runner sanitises every child-behaviour variable except the G4 subject", () => {
    for (const variable of [
      "VIBORM_RAPTOR3_REPLAY_PATH",
      "VIBORM_RAPTOR3_GENERATED_FIRST_SEED",
      "VIBORM_RAPTOR3_EXTENSION_SLICE",
      "VIBORM_RAPTOR3_SPECIMEN",
    ])
      assert.ok(
        RUNNER.includes(`delete environment.${variable}`),
        `${variable} is no longer sanitised`
      );
    assert.equal(
      RUNNER.includes("VIBORM_RAPTOR3_G4_SUBJECT"),
      false,
      "the runner now knows about the G4 subject variable"
    );
  });

  it("the runner picks the weaker assertion from the receipt's own subject", () => {
    assert.match(
      RUNNER,
      /receipt\.subject === "shipped"\s*\?\s*assertG4OracleValidationReceipt\s*:\s*assertG4GeneratedBatchReceipt/,
      "the receipt no longer selects its own assertion"
    );
  });

  it("an ambient shipped subject produces an indistinguishable verified run", () => {
    const receipt = JSON.parse(
      readFileSync(`${RECEIPTS}/generated-campaign.json`, "utf8")
    );
    assert.equal(receipt.subject, "shipped");
    assert.equal(receipt.qualifying, false);
    assert.equal(receipt.completed.length, 200);

    const verified = JSON.parse(readFileSync(`${RECEIPTS}/verified.json`, "utf8"));
    assert.equal(verified.mode, "g4-seed-batch");
    assert.equal(
      "subject" in verified,
      false,
      "verified.json now records the subject"
    );
    assert.equal(
      "qualifying" in verified,
      false,
      "verified.json now records qualification"
    );

    const log = readFileSync(`${RECEIPTS}/runner.log`, "utf8");
    assert.match(log, /Raptor 3 g4-seed-batch contract gate verified/);
    assert.equal(
      /oracle-validation|shipped|not qualifying/.test(log),
      false,
      "the runner's output now says the child did not qualify"
    );
  });

  it("the campaign-level receipt records no subject for any of its children", () => {
    assert.match(
      RUNNER,
      /JSON\.stringify\(\s*\{ mode: request\.mode, identity, campaign, batches \}/,
      "the campaign receipt shape changed"
    );
    assert.match(
      RUNNER,
      /batches\.push\(\{\s*firstSeed,\s*directory: receiptDirectory,/,
      "the per-batch record shape changed"
    );
  });
});
