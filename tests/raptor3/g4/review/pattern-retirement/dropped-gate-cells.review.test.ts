/**
 * G4 pattern-retirement INDEPENDENT review — the gate that was deleted whole.
 *
 * `tests/contracts/engine/write/architecture-gates.core.test.ts` (deleted by
 * this unit, readable at `e8114ed9`) held five cells. Three read
 * `write-engine/OperationExecutor.ts` or `OperationFragment.ts` and genuinely
 * lost their subject. TWO did not:
 *
 *   (b) "forbids adapters from constructing a Step" — scans `src/adapters`;
 *   (e) "keeps write-engine runtime imports acyclic" — reads
 *       `scripts/query-engine-structure.mjs`'s `writeEngine.runtimeImportCycles`.
 *
 * Both subjects still exist, so both cells still RUN and still PASS on the
 * retired tree. This probe is the measurement behind review finding 4: the
 * note's "three of its five cells have no subject left" is exact, but the
 * disposition dropped two live cells without saying so. Cell (b) is now
 * vacuous (nothing declares the step vocabulary any more — the closure probe
 * pins that separately); cell (e) is a live, if cheap, structural ratchet.
 *
 * FOLLOW-UP F-2/F-6 moved the last `write-engine/` file to `raptor3/shared/`
 * and deleted the directory, so the census no longer has a `writeEngine` key to
 * report — the second measurement would have measured nothing. Cell (e) keeps
 * its subject by following it: the census's `queryEngine` measurement is the
 * whole engine, `raptor3/` included, and the cycle ratchet is stated over that.
 * It is a CEILING, not an equality, because the one component measured here
 * (`raptor3/commands/commands.ts` <-> `raptor3/commands/execution.ts`) must be
 * free to disappear; a SECOND component reddens the cell. The absence of the
 * `writeEngine` key is asserted in the same cell, so a future re-introduction of
 * a second engine directory under its own census key is not silent either.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPOSITORY_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

const ADAPTERS = join(REPOSITORY_ROOT, "src/adapters");
const STRUCTURE_REPORT = join(
  REPOSITORY_ROOT,
  "scripts/query-engine-structure.mjs"
);
const STEP_VOCABULARY =
  /\b(?:StatementStep|GuardStep|OperationStep|OperationFragment)\b/;
const FRAGMENT_IMPORT = /["'][^"']*query-engine-v2[^"']*["']/;

function listTypeScriptFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? listTypeScriptFiles(path) : [path];
    })
    .filter((path) => path.endsWith(".ts"));
}

describe("the two deleted gate cells whose subject survived", () => {
  it("(b) still has a subject: src/adapters exists and declares no Step", () => {
    expect(listTypeScriptFiles(ADAPTERS).length).toBeGreaterThan(0);
    const offenders = listTypeScriptFiles(ADAPTERS).filter((path) => {
      const source = readFileSync(path, "utf8");
      return STEP_VOCABULARY.test(source) || FRAGMENT_IMPORT.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("(e) still has a subject: the census reports the engine's import cycles", () => {
    const report = JSON.parse(
      execFileSync(process.execPath, [STRUCTURE_REPORT], { encoding: "utf8" })
    ) as {
      writeEngine?: unknown;
      queryEngine?: { files?: number; runtimeImportCycles?: string[][] };
    };
    // The deleted directory has no census key of its own any more.
    expect(report.writeEngine).toBeUndefined();
    const queryEngine = report.queryEngine;
    expect(queryEngine).toBeDefined();
    expect(queryEngine?.files).toBeGreaterThan(0);
    // Measured ceiling, not an equality: one component today, and a second one
    // fails here.
    expect(queryEngine?.runtimeImportCycles?.length).toBeLessThanOrEqual(1);
  });
});
