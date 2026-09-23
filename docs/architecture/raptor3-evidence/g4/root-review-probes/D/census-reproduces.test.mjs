/**
 * Root review, area D — the census in `g4/root-review-D-census.json` is
 * reproducible on the frozen tree, and the tree is still the frozen identity.
 *
 * This cell is review evidence, not a registered mode. It fails if the census
 * numbers were transcribed rather than measured, if the census method drifts
 * from the one the G3 accounting recorded, or if the tree moved off the freeze.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PROBE = resolve(fileURLToPath(new URL(".", import.meta.url)));
const ROOT = resolve(PROBE, "../../../../../..");
const CENSUS = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/root-review-D-census.json"
);

const recorded = JSON.parse(readFileSync(CENSUS, "utf8"));

function rerun(script) {
  return JSON.parse(
    execFileSync(process.execPath, [resolve(PROBE, script)], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
  );
}

describe("root review D — census and identity", () => {
  it("the tree is still the frozen identity", () => {
    const frozen = JSON.parse(
      readFileSync(
        resolve(ROOT, "docs/architecture/raptor3-evidence/g4/freeze/identity.json"),
        "utf8"
      )
    );
    expect(rerun("capture-identity.mjs")).toEqual(frozen);
    expect(frozen.production).toBe(
      "e2d5bcb2201641372941c2c1fa6e648f52429fb3ca8ce948678baa80a31b589f"
    );
    expect(frozen.harness).toBe(
      "838a1e1bb2080e863f5decb56ce90c5218da1e1a341532c21d5b0e04453bc6c5"
    );
  });

  it("the census method is the one the G3 accounting recorded", () => {
    expect(recorded.method.censusFunctionSha256).toBe(
      "15889231a22297fcf001ae22ca01e6e8c9cd7489dd635c60529dfdc0ac06461e"
    );
    expect(recorded.method.censusFunctionMatchesG3).toBe(true);
  });

  it("the whole census reproduces, every group and every delta", () => {
    const fresh = rerun("census.mjs");
    const strip = (report) => {
      const { producedAt, ...rest } = report;
      return rest;
    };
    expect(strip(fresh)).toEqual(strip(recorded));
  });

  it("re-measuring the G3 file list at 0cc61e61 reproduces the G3 closure figures", () => {
    expect(recorded.atBase.candidateCore12).toMatchObject({
      files: 12,
      tokenLines: 6927,
      physicalLines: 6997,
      bytes: 230397,
    });
    expect(recorded.atBase.g3CompleteChargedPerimeter30).toMatchObject({
      files: 30,
      tokenLines: 11849,
      physicalLines: 14486,
      bytes: 499927,
    });
  });

  it("the per-unit cumulative core deltas sum to the measured delta", () => {
    const totals = recorded.perUnitCumulative.perUnitTotals;
    expect(totals.sum).toBe(totals.measuredDelta);
    const chain = recorded.perUnitCumulative.chain;
    expect(chain.reduce((sum, row) => sum + row.delta, 0)).toBe(
      recorded.perUnitCumulative.measuredAtFreeze - recorded.perUnitCumulative.base.tokenLines
    );
  });

  it("no candidate module enters any frozen bundle fixture's runtime graph", () => {
    const reach = rerun("bundle-reach.mjs");
    for (const fixture of ["engine", "pg-simple", "pg-relations"]) {
      expect(reach[fixture].candidateModulesReached).toEqual([]);
    }
  });

  it("every relative evidence link under g4/ resolves", () => {
    const links = rerun("link-check.mjs");
    expect(links.missing).toEqual([]);
    expect(links.linksChecked).toBeGreaterThan(900);
  });
});
