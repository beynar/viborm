/**
 * G4-02 author check — finding K (refusal precedence), copied verbatim from the
 * G4-01 third-review probe estate
 * (`/private/tmp/viborm-g4-unit01/tests/raptor3/g4/review/unit01-followup3/`)
 * except for the one import path below. The integrator delegated finding K to
 * this unit with these two files as the witness (`g4.md`, G4-01 round 3).
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes, ledRefs } from "./k-decimal-world";

/**
 * Third review (repair 3). The two repairs that ADD or MOVE a throw can change
 * which refusal a caller sees when a single call violates two contracts at
 * once. The candidate raises the decimal-domain refusal while PREPARING the
 * selector; the shipped engine raises it while BUILDING the SQL, after it has
 * normalized the cursor order. If the two owners run in a different order, the
 * same call answers a different error identity on each engine.
 */
const agrees = (
  label: string,
  seen: { shipped: unknown; candidate: unknown }
): void => {
  assert.deepEqual(
    seen.candidate,
    seen.shipped,
    `${label}\n  candidate ${JSON.stringify(seen.candidate)}\n  shipped   ${JSON.stringify(seen.shipped)}`
  );
};

describe("G4-01 repair 3 review — which refusal wins when two are owed", () => {
  it("decimal domain vs the cursor refusal", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.micros } },
      orderBy: { lines: { _count: "asc" } },
      cursor: { id: 1 },
      take: 2,
      select: { id: true },
    });
    agrees("decimal mismatch beside a cursor refusal", seen);
  });

  it("decimal domain vs the cross-model scope refusal, in one filter", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: {
        AND: [
          { cents: { equals: ledRefs.micros } },
          { count: { equals: ledRefs.id } },
        ],
      },
      select: { id: true },
    });
    agrees("two guards in one AND", seen);
  });

  it("decimal domain vs a null cursor field", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.micros } },
      orderBy: { id: "asc" },
      cursor: { id: 99 },
      take: 2,
      select: { id: true },
    });
    agrees("decimal mismatch beside an absent cursor row", seen);
  });

  it("the cursor refusal vs an unknown-field selector", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { nope: 1 } as Record<string, unknown>,
      orderBy: { lines: { _count: "asc" } },
      cursor: { id: 1 },
      take: 2,
      select: { id: true },
    });
    agrees("admission vs cursor refusal", seen);
  });
});
