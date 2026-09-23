/**
 * Independent review probes (round 3) — what the §16 receipts actually cover.
 *
 * `note.md` §16 exists, in its own words, because "§15.7 measured every
 * accepted claim at production `7475621b…`. The G4-02 phase-2 author has kept
 * landing `src/` since, so the integrator would otherwise carry accepted
 * numbers taken against a tree that no longer exists."
 *
 * These cells check that stated purpose against the receipts the round wrote.
 * Each FAILS when the invariant does not hold; a failing cell here is the
 * finding, not a request to re-run anything.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const VERIFY = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/receipts/followup-verify"
);
const REPAIR = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/receipts/repair"
);

interface Identity {
  readonly production: string;
  readonly harness: string;
}
interface Receipt {
  readonly identity?: Identity;
  readonly production?: string;
  readonly harness?: string;
}

const readJson = (path: string): Receipt =>
  JSON.parse(readFileSync(path, "utf8")) as Receipt;

const identityOf = (receipt: Receipt): Identity | undefined =>
  receipt.identity ??
  (receipt.production !== undefined && receipt.harness !== undefined
    ? { production: receipt.production, harness: receipt.harness }
    : undefined);

function walk(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) found.push(...walk(path));
    else if (entry.endsWith(".json")) found.push(path);
  }
  return found;
}

const runReceipts = () =>
  walk(VERIFY).filter((path) => /\/(attempt|verified)\.json$/.test(path));

describe("review probe (round 3): the verification pass's own identity", () => {
  it("carries an identity on every run receipt it wrote", () => {
    const receipts = runReceipts();
    assert.ok(receipts.length > 0, "no run receipts were written at all");
    for (const path of receipts)
      assert.ok(
        identityOf(readJson(path)),
        `${path} records no executed-source identity`
      );
  });

  it("measured the accepted claims at a DIFFERENT production identity than the round it re-measures", () => {
    // The round's stated purpose. If every §16 run carries the same production
    // fingerprint as the §15.7 receipts, the re-measurement re-measured the
    // same `src/` the accepted record already covered.
    const before = identityOf(readJson(join(REPAIR, "identity-after-repair.json")));
    assert.ok(before, "the repair round recorded no closing identity");
    const productions = new Set(
      runReceipts()
        .map((path) => identityOf(readJson(path))?.production)
        .filter((value): value is string => value !== undefined)
    );
    assert.deepEqual(
      [...productions].filter((production) => production === before.production),
      [],
      `the verification pass ran at the repair round's own production identity ${before.production.slice(0, 8)}…`
    );
  });

  it("closes at the identity its own runs were taken at", () => {
    // A round that exists to re-measure "the identity that will actually be
    // qualified" must close at the identity its numbers belong to, or the
    // integrator carries numbers from a tree that moved mid-round — the exact
    // condition the round was opened to remove.
    const after = identityOf(readJson(join(VERIFY, "identity-after.json")));
    assert.ok(after, "the verification pass recorded no closing identity");
    for (const path of runReceipts()) {
      const identity = identityOf(readJson(path));
      assert.equal(
        identity?.production,
        after.production,
        `${path} was measured at production ${identity?.production.slice(0, 8)}…, the round closed at ${after.production.slice(0, 8)}…`
      );
    }
  });

  it("keeps the harness half stable across the round it claims edited nothing", () => {
    const before = identityOf(readJson(join(VERIFY, "identity-before.json")));
    const after = identityOf(readJson(join(VERIFY, "identity-after.json")));
    assert.ok(before && after);
    assert.equal(before.harness, after.harness);
    for (const path of runReceipts())
      assert.equal(
        identityOf(readJson(path))?.harness,
        after.harness,
        `${path} was measured at a harness the round's brackets never saw`
      );
  });
});
