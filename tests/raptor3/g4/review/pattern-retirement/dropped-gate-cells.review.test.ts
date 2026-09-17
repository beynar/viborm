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

  it("(e) still has a subject: the census still reports write-engine cycles", () => {
    const report: unknown = JSON.parse(
      execFileSync(process.execPath, [STRUCTURE_REPORT], { encoding: "utf8" })
    );
    const writeEngine = (
      report as {
        writeEngine?: { files?: number; runtimeImportCycles?: unknown };
      }
    ).writeEngine;
    expect(writeEngine).toBeDefined();
    expect(writeEngine?.files).toBe(1);
    expect(writeEngine?.runtimeImportCycles).toEqual([]);
  });
});
