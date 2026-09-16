import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { bothOutcomes, ledRefs } from "./decimal-world";

/**
 * Third review (repair 3), finding J. The remaining entry points a field-ref
 * operand can reach: a `having` aggregate operand, a unique selector, a
 * distinct window, and a relation-scoped `none`. A new refusal must not change
 * the answer on any of them, in either direction.
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

describe("G4-01 repair 3 review — every other route to a field-ref operand", () => {
  it("agrees on a reference inside a `having` aggregate operand", async () => {
    const seen = await bothOutcomes("led", "groupBy", {
      by: ["tag"],
      having: { cents: { _sum: { gt: ledRefs.micros } } },
      _count: true,
    });
    agrees("having aggregate reference", seen);
  });

  it("agrees on a reference inside a unique selector", async () => {
    const seen = await bothOutcomes("led", "findUnique", {
      where: { id: 1, cents: { equals: ledRefs.micros } },
      select: { id: true },
    });
    agrees("findUnique reference", seen);
  });

  it("agrees on a refusing reference beside `distinct`", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.micros } },
      distinct: ["tag"],
      select: { id: true, tag: true },
    });
    agrees("distinct reference", seen);
    assert.ok(
      (seen.candidate as { error?: string }).error?.includes(
        "Two decimals compare exactly"
      ),
      `distinct should refuse, saw ${JSON.stringify(seen.candidate)}`
    );
  });

  it("agrees on a refusing reference inside a `none` quantifier", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { lines: { none: { fee: { lt: ledRefs.micros } } } },
      select: { id: true },
    });
    agrees("none-scoped reference", seen);
  });

  it("agrees on a refusing reference beside a window and a cursor", async () => {
    const seen = await bothOutcomes("led", "findMany", {
      where: { cents: { equals: ledRefs.micros } },
      orderBy: { id: "asc" },
      cursor: { id: 1 },
      take: -1,
      select: { id: true },
    });
    agrees("windowed reference", seen);
    assert.ok(
      (seen.candidate as { error?: string }).error?.includes(
        "Two decimals compare exactly"
      ),
      `windowed read should refuse, saw ${JSON.stringify(seen.candidate)}`
    );
  });
});
