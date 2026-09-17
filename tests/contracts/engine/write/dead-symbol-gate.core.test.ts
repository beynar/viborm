import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * The dead-symbol gate. It makes two deletions permanent.
 *
 * P6 Stage 3 deleted V1's direct-client write engine and Stage 4 added this gate so
 * the absence stays. D-15 (the pattern retirement) then deleted the `pattern/`
 * experiment and the 111 production owners it alone kept alive: `builders/` whole,
 * `operations/` bar `groupby-fields.ts`, `result/`'s V1 parser tree, all of
 * `write-engine/` bar `parse-boundary.ts`, and four `query-engine/` root files.
 *
 * Every deleted module/class name must appear in no CODE anywhere in
 * `src/**​/*.ts` — an import of a resurrected file, a copy-pasted class, a
 * `new`/`extends`/type reference the compiler would accept via a same-named new
 * symbol all turn this red. The estate cell adds what a symbol scan cannot see: a
 * deleted DIRECTORY back on disk, or a second file beside the one parse boundary
 * `write-engine/` still owns.
 *
 * The scan is over source `.ts` CODE only, with comments stripped: the migration
 * documents V2's behavioural lineage in provenance comments (“reproduces V1's
 * `RelationRemovals.set` message, byte-identical”), which are history, exactly like
 * the design docs (`*.md`). A dead-SYMBOL gate targets symbols — imports and
 * identifiers — not prose. Matching is whole-identifier (`\bNAME\b`) so a kept
 * lookalike (`RelationMutationPlan`, `buildManyToManyJoinParts`, `OperationProgram`)
 * never trips it. `OperationExecutor` was one of those kept lookalikes until D-15
 * deleted it; it is a listed dead symbol now.
 *
 * One deleted module name is deliberately absent: `write-engine/Part.ts`. `\bPart\b`
 * is too common a word to be a symbol gate and would redden on an unrelated future
 * identifier; the estate cell covers that directory instead.
 *
 * Falsified: re-add any deleted name to `src` CODE (e.g. resurrect the
 * `OperationRuntime` import in `pending-operation.ts`) and this gate fails, naming
 * the file and symbol; put `src/query-engine/builders/` or `pattern/` back on disk,
 * or a second `.ts` beside `parse-boundary.ts`, and the estate cell fails naming it.
 */

const DELETED_V1_SYMBOLS = [
  // P6 Stage 3 — the direct client's write engine.
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
  // D-15 — the pattern experiment itself (the second way to compile an operation).
  "constructPattern",
  "constructMemberPatterns",
  "matchWriteResult",
  "ScheduledFragment",
  // D-15 — what a V1 operation lowered to, and who executed it.
  "OperationFragment",
  "OperationExecutor",
  "FragmentValidator",
  "RecordSeriesOperation",
  "StepScope",
  "createRacePin",
  "markRaceable",
  "isRetryableRace",
  "buildSeriesResultReads",
  "buildTargetProjection",
  "groupLinkTargets",
  "executeSkippableWrite",
  // D-15 — how a V1 verb built its SQL.
  "JunctionStatements",
  "TargetConstraint",
  "uniqueConflictTarget",
  "buildSubqueryInclude",
  "buildLateralInclude",
  "buildMutationProjectionFold",
  // D-15 — how a provider row became a result.
  "ResultParser",
  "createRowParser",
  "parseResultRows",
  "decodeRelationCarrier",
] as const;

const SRC = SOURCE_ROOT;
const QUERY_ENGINE = join(SRC, "query-engine");

/** Deleted whole by D-15: neither may come back under its own name. */
const RETIRED_DIRECTORIES = ["builders", "pattern"] as const;

/** What `write-engine/` holds after D-15: the one live boundary, and the two
 *  guides that stay RETIRED-headed because eleven plans under `docs/` cite them. */
const WRITE_ENGINE_ESTATE = ["ATOM.md", "README.md", "parse-boundary.ts"];

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

describe("dead-symbol gate: V1's write engine and the retired pattern estate leave no trace in src", () => {
  it.each(
    DELETED_V1_SYMBOLS
  )("the deleted symbol '%s' appears in no src file", (name) => {
    expect(occurrences(name)).toEqual([]);
  });

  it("leaves no directory of the retired estate on disk", () => {
    expect(
      RETIRED_DIRECTORIES.filter((name) => existsSync(join(QUERY_ENGINE, name)))
    ).toEqual([]);
    expect(readdirSync(join(QUERY_ENGINE, "write-engine")).sort()).toEqual(
      WRITE_ENGINE_ESTATE
    );
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
