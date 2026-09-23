/**
 * Independent review probes (round 3) — what the G4-01 landing changed.
 *
 * `note.md` §14.5: the author's checks and the reviewer probes were copied
 * from `/private/tmp/viborm-g4-unit01` into the main tree and "one byte change
 * was made to the landed files", the TS2638 at
 * `review/unit01-followup2/cursor-refusal.test.ts:29`, 1,574 -> 1,670 bytes.
 * A landing that quietly weakened one of the reviewer's probes would be
 * invisible in every count.
 *
 * Each cell states the invariant and FAILS when it does not hold.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, it } from "vitest";
import {
  G4_UNIT01_AUTHOR_COUNTS,
  G4_UNIT01_REVIEW_COUNTS,
} from "../../../../../scripts/raptor3-manifest.mjs";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const SOURCE_WORKTREE = "/private/tmp/viborm-g4-unit01";
const LANDED = [
  "tests/raptor3/g4/unit01",
  "tests/raptor3/g4/review/unit01",
  "tests/raptor3/g4/review/unit01-followup",
  "tests/raptor3/g4/review/unit01-followup2",
  "tests/raptor3/g4/review/unit01-followup3",
];
const REPAIRED = "tests/raptor3/g4/review/unit01-followup2/cursor-refusal.test.ts";

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else found.push(path);
  }
  return found;
}

describe("review probe (round 3): the landed G4-01 evidence", () => {
  it("changed exactly one landed file, and only where the TS2638 was", () => {
    if (!existsSync(SOURCE_WORKTREE)) {
      assert.fail(
        `the source worktree ${SOURCE_WORKTREE} is gone; this claim can no longer be checked`
      );
    }
    const differing: string[] = [];
    for (const directory of LANDED) {
      const source = join(SOURCE_WORKTREE, directory);
      const landed = resolve(ROOT, directory);
      const sourceFiles = walk(source).map((path) => relative(source, path));
      const landedFiles = walk(landed).map((path) => relative(landed, path));
      assert.deepEqual(
        landedFiles.sort(),
        sourceFiles.sort(),
        `${directory} did not land file-for-file`
      );
      for (const file of sourceFiles)
        if (
          !readFileSync(join(source, file)).equals(
            readFileSync(join(landed, file))
          )
        )
          differing.push(`${directory}/${file}`);
    }
    assert.deepEqual(differing, [REPAIRED], "the landing changed other files");
  });

  it("repaired the TS2638 without changing what the probe asserts", () => {
    const landed = readFileSync(resolve(ROOT, REPAIRED), "utf8");
    assert.equal(
      readFileSync(resolve(ROOT, REPAIRED)).byteLength,
      1670,
      "the repaired probe is not the size the note records"
    );
    // The repair may only annotate the `orderBy.team` read; the call it wraps,
    // the refusal it compares and the cells it drives are the probe's claim.
    assert.ok(landed.includes('"label" in team ? "member" : "team"'));
    assert.ok(landed.includes("cursor: { id: 1 }"));
    assert.equal(
      landed.includes(".skip") || landed.includes(".todo"),
      false,
      "the landing weakened the probe into a skip"
    );
  });

  it("registers every landed file and every landed file only", () => {
    const registered = new Set([
      ...Object.keys(G4_UNIT01_AUTHOR_COUNTS),
      ...Object.keys(G4_UNIT01_REVIEW_COUNTS),
    ]);
    const present = LANDED.flatMap((directory) =>
      walk(resolve(ROOT, directory))
        .map((path) => relative(ROOT, path))
        .filter((path) => path.endsWith(".test.ts"))
    );
    assert.deepEqual(
      present.filter((file) => !registered.has(file)),
      [],
      "a landed suite runs in no registered mode"
    );
    assert.deepEqual(
      [...registered].filter((file) => !present.includes(file)),
      [],
      "a registered suite is not in the tree"
    );
  });

  it("pins counts that no cell can satisfy by being skipped", () => {
    for (const file of [
      ...Object.keys(G4_UNIT01_AUTHOR_COUNTS),
      ...Object.keys(G4_UNIT01_REVIEW_COUNTS),
    ]) {
      const source = readFileSync(resolve(ROOT, file), "utf8");
      for (const weakening of ["it.skip(", "it.todo(", "describe.skip(", "it.only("])
        assert.equal(
          source.includes(weakening),
          false,
          `${file} carries ${weakening}`
        );
    }
  });
});
