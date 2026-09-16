/**
 * Independent review probes (round 4) — the untracked corpus snapshot.
 *
 * The round-3 review's must-fix 3 was that `tests/raptor3/g4/**` is untracked,
 * appears in no patch, and had no recorded bytes in any round, so claims about
 * what the fixture contained could not be checked by anyone. The repair writes
 * a per-round byte snapshot under `receipts/repair2/corpus/`.
 *
 * These cells check that the snapshot is a measurement and not a statement:
 * the declared totals are recomputed from the per-file rows, the delta is
 * recomputed from the two snapshots, and the rows are compared with the files
 * on disk today. The worktree comparison is recomputed from the SNAPSHOT, so it
 * keeps working once `/private/tmp/viborm-g4-unit01` is gone — which is the
 * whole point of the repair.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const CORPUS = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/receipts/repair2/corpus"
);

interface FileRow {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly owner: string;
}
interface OwnerTotals {
  readonly files: number;
  readonly bytes: number;
}
interface Snapshot {
  readonly files: number;
  readonly bytes: number;
  readonly byOwner: Record<string, OwnerTotals>;
  readonly landed: readonly FileRow[];
}
interface Delta {
  readonly openFiles: number;
  readonly closeFiles: number;
  readonly added: readonly FileRow[];
  readonly removed: readonly FileRow[];
  readonly changed: readonly FileRow[];
  readonly witnessOwnedUnchanged: boolean;
}
interface WorktreeSide {
  readonly bytes: number;
  readonly sha256: string;
}
interface WorktreeComparison {
  readonly files: number;
  readonly identical: number;
  readonly differing: readonly {
    readonly path: string;
    readonly worktree: WorktreeSide;
    readonly landed: WorktreeSide;
  }[];
}

const readSnapshot = (name: string): Snapshot =>
  JSON.parse(readFileSync(join(CORPUS, name), "utf8")) as Snapshot;

const sha256 = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex");

describe("review probe (round 4): the untracked corpus snapshot", () => {
  it("declares totals that its own rows add up to", () => {
    for (const name of ["g4-corpus-open.json", "g4-corpus-close.json"]) {
      const snapshot = readSnapshot(name);
      assert.equal(snapshot.landed.length, snapshot.files, name);
      assert.equal(
        snapshot.landed.reduce((total, row) => total + row.bytes, 0),
        snapshot.bytes,
        name
      );
      const byOwner = new Map<string, OwnerTotals>();
      for (const row of snapshot.landed) {
        const current = byOwner.get(row.owner) ?? { files: 0, bytes: 0 };
        byOwner.set(row.owner, {
          files: current.files + 1,
          bytes: current.bytes + row.bytes,
        });
      }
      assert.deepEqual(
        Object.fromEntries([...byOwner].sort()),
        Object.fromEntries(Object.entries(snapshot.byOwner).sort()),
        name
      );
    }
  });

  it("records a delta that the two snapshots reproduce", () => {
    const open = readSnapshot("g4-corpus-open.json");
    const close = readSnapshot("g4-corpus-close.json");
    const delta = JSON.parse(
      readFileSync(join(CORPUS, "g4-corpus-delta.json"), "utf8")
    ) as Delta;
    const before = new Map(open.landed.map((row) => [row.path, row]));
    const after = new Map(close.landed.map((row) => [row.path, row]));
    const added = [...after.keys()].filter((path) => !before.has(path));
    const removed = [...before.keys()].filter((path) => !after.has(path));
    const changed = [...before.keys()].filter(
      (path) => after.has(path) && after.get(path)?.sha256 !== before.get(path)?.sha256
    );
    assert.equal(delta.openFiles, open.files);
    assert.equal(delta.closeFiles, close.files);
    assert.deepEqual(delta.added.map((row) => row.path).sort(), added.sort());
    assert.deepEqual(delta.removed.map((row) => row.path).sort(), removed.sort());
    assert.deepEqual(delta.changed.map((row) => row.path).sort(), changed.sort());
    const witnessUnchanged = [...before.values()]
      .filter((row) => row.owner === "witness")
      .every((row) => after.get(row.path)?.sha256 === row.sha256);
    assert.equal(delta.witnessOwnedUnchanged, witnessUnchanged);
  });

  it("matches the files on disk wherever this stream owns them", () => {
    // The snapshot's purpose is that a later round can diff against it. If a
    // witness-owned fixture changes without a new snapshot, this cell is the
    // falsifier that says so.
    const close = readSnapshot("g4-corpus-close.json");
    for (const row of close.landed.filter((file) => file.owner === "witness")) {
      const path = resolve(ROOT, row.path);
      assert.ok(existsSync(path), `${row.path} disappeared after the snapshot`);
      assert.equal(sha256(path), row.sha256, `${row.path} changed after the snapshot`);
    }
  });

  it("keeps the landed-versus-worktree claim checkable without the worktree", () => {
    const comparison = JSON.parse(
      readFileSync(join(CORPUS, "landed-vs-unit01-worktree.json"), "utf8")
    ) as WorktreeComparison;
    const lines = readFileSync(join(CORPUS, "unit01-source-worktree.sha256"), "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0);
    assert.equal(lines.length, comparison.files);
    let identical = 0;
    const differing: string[] = [];
    for (const line of lines) {
      const parts = line.trim().split(/\s+/);
      const hash = parts[0];
      const relative = parts[2];
      assert.ok(hash && relative, `unreadable snapshot line: ${line}`);
      const landed = resolve(ROOT, relative);
      assert.ok(existsSync(landed), `${relative} is not landed`);
      if (sha256(landed) === hash) identical += 1;
      else differing.push(relative);
    }
    assert.equal(identical, comparison.identical);
    assert.deepEqual(differing, comparison.differing.map((row) => row.path));
    for (const row of comparison.differing) {
      const landed = resolve(ROOT, row.path);
      assert.equal(readFileSync(landed).length, row.landed.bytes);
      assert.equal(sha256(landed), row.landed.sha256);
    }
  });
});
