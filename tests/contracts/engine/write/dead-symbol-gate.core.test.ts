import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * The dead-symbol gate (P6 Stage 4). V1's write engine was deleted in Stage 3;
 * this gate makes its absence permanent. Every deleted module/class name must
 * appear in no CODE anywhere in `src/**​/*.ts` — an import of a resurrected file, a
 * copy-pasted class, a `new`/`extends`/type reference the compiler would accept via
 * a same-named new symbol all turn this red.
 *
 * The scan is over source `.ts` CODE only, with comments stripped: the migration
 * documents V2's behavioural lineage in provenance comments (“reproduces V1's
 * `RelationRemovals.set` message, byte-identical”), which are history, exactly like
 * the design docs (`*.md`). A dead-SYMBOL gate targets symbols — imports and
 * identifiers — not prose. Matching is whole-identifier (`\bNAME\b`) so a kept
 * lookalike (`RelationMutationPlan`, `buildManyToManyJoinParts`, `OperationExecutor`,
 * `OperationProgram`) never trips it.
 *
 * Falsified: re-add any deleted name to `src` CODE (e.g. resurrect the
 * `OperationRuntime` import in `pending-operation.ts`) and this gate fails, naming
 * the file and symbol.
 */

const DELETED_V1_SYMBOLS = [
  "OperationCompiler",
  "OperationResults",
  "OperationRuntime",
  "OperationBatchRuntime",
  "WriteOperations",
  "WritePrograms",
  "RelationUpdates",
  "RelationMutations",
  "RelationUpserts",
  "RelationBranches",
  "RelationCaptures",
  "RelationRemovals",
  "ManyToManyMutations",
  "ManyToManyMemberships",
  "MutationStatements",
] as const;

const SRC = SOURCE_ROOT;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const LINE_COMMENT = /\/\/[^\n]*/g;

/** The file's code with block and line comments stripped (provenance prose lives
 *  in comments; a dead-symbol gate targets code). */
function code(source: string): string {
  return source.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
}

/** A whole-identifier matcher for `name` (dynamic — one per deleted symbol). */
function wholeWord(name: string): RegExp {
  // biome-ignore lint/performance/useTopLevelRegex: built once per deleted symbol
  return new RegExp(`\\b${name}\\b`);
}

function occurrences(name: string): string[] {
  const pattern = wholeWord(name);
  const hits: string[] = [];
  for (const file of sourceFiles(SRC)) {
    if (pattern.test(code(readFileSync(file, "utf8")))) {
      hits.push(file.slice(SRC.length + 1));
    }
  }
  return hits;
}

describe("P6 dead-symbol gate: direct client's write engine leaves no trace in src", () => {
  it.each(
    DELETED_V1_SYMBOLS
  )("the deleted symbol '%s' appears in no src file", (name) => {
    expect(occurrences(name)).toEqual([]);
  });

  it("the scanner would catch a re-introduced symbol (matcher self-check)", () => {
    // A live falsification of the detector itself: the same whole-word matcher DOES
    // find a deleted name when one is present, so a green run above is a real
    // absence, not a broken scanner. It also does NOT match a kept lookalike.
    expect(
      wholeWord("OperationCompiler").test(
        "import { x } from './OperationCompiler';"
      )
    ).toBe(true);
    expect(wholeWord("RelationMutations").test("RelationMutationPlan")).toBe(
      false
    );
  });
});
