/**
 * G4-02 author check — finding K (refusal precedence), copied verbatim from the
 * G4-01 third-review probe estate
 * (`/private/tmp/viborm-g4-unit01/tests/raptor3/g4/review/unit01-followup3/`)
 * except for the one import path below. The integrator delegated finding K to
 * this unit with these two files as the witness (`g4.md`, G4-01 round 3).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes, ledRefs, lineRefs } from "./k-decimal-world";

/**
 * Third review (repair 3). `competing-refusals.test.ts` shows the candidate
 * answering the WHERE refusal where the shipped engine answers the CURSOR one.
 * These probes ask whether that ordering is something repair 3 introduced, or a
 * standing property of the candidate's one-pass preparation: each pairs a
 * where-owned refusal that existed BEFORE this repair with the same cursor
 * violation.
 */
const both = async (where: Record<string, unknown>) =>
  await bothOutcomes("led", "findMany", {
    where,
    orderBy: { lines: { _count: "asc" } },
    cursor: { id: 1 },
    take: 2,
    select: { id: true },
  });

const shortName = (seen: { shipped: unknown; candidate: unknown }) => ({
  candidate: String((seen.candidate as { error?: string }).error).slice(0, 40),
  shipped: String((seen.shipped as { error?: string }).error).slice(0, 40),
});

describe("G4-01 repair 3 review — is the refusal ORDER new?", () => {
  it("cross-model scope refusal (r2 code) beside the cursor violation", async () => {
    const seen = await both({ cents: { equals: lineRefs.fee } });
    const names = shortName(seen);
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `pre-existing scope refusal vs cursor refusal\n  candidate ${names.candidate}\n  shipped   ${names.shipped}`
    );
  });

  it("GeoPoint-free control: a plain unsatisfiable filter beside the cursor violation", async () => {
    const seen = await both({ tag: "nothing" });
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `plain filter vs cursor refusal\n  ${JSON.stringify(seen)}`
    );
  });

  it("decimal domain refusal (r5 code) beside the cursor violation", async () => {
    const seen = await both({ cents: { equals: ledRefs.micros } });
    const names = shortName(seen);
    assert.deepEqual(
      seen.candidate,
      seen.shipped,
      `r5 decimal refusal vs cursor refusal\n  candidate ${names.candidate}\n  shipped   ${names.shipped}`
    );
  });
});
