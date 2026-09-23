/**
 * Independent review probes — what the follow-up's receipts say about the
 * identity they ran on.
 *
 * Claim under test (note.md §14 preamble and §14.8):
 *   "Identity when the census below was taken: production `d844ae0f…`,
 *    harness `72fbd01e…`. … every red recorded here is red against `d844ae0f…`
 *    and is not claimed against any other identity."
 *   "Every receipt in this follow-up except the four CLI attempts and the
 *    parse-level check was produced at harness `72fbd01e…`."
 *
 * Each cell FAILS when the receipts on disk contradict the note.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../../..");
const FOLLOWUP = resolve(
  ROOT,
  "docs/architecture/raptor3-evidence/g4/witness/receipts/followup"
);

interface Receipt {
  readonly path: string;
  readonly production: string;
  readonly harness: string;
}

function receipts(directory = FOLLOWUP, found: Receipt[] = []): Receipt[] {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) receipts(path, found);
    else if (entry.name.endsWith(".json")) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      const identity = (parsed as { identity?: Record<string, string> })
        ?.identity;
      if (identity?.harness && identity?.production)
        found.push({
          path: path.slice(FOLLOWUP.length + 1),
          production: identity.production,
          harness: identity.harness,
        });
    }
  }
  return found;
}

describe("review probe: the follow-up's receipt identities", () => {
  it("records an identity on every run receipt (control, expected green)", () => {
    const found = receipts();
    assert.ok(found.length >= 8, `only ${found.length} receipts carry identity`);
  });

  it("was produced at the single harness identity the note names", () => {
    const harnesses = new Map<string, string[]>();
    for (const receipt of receipts())
      harnesses.set(receipt.harness, [
        ...(harnesses.get(receipt.harness) ?? []),
        receipt.path,
      ]);
    assert.deepEqual(
      [...harnesses.keys()].map((hash) => hash.slice(0, 8)).sort(),
      ["72fbd01e"],
      `receipts span ${harnesses.size} harness identities: ${JSON.stringify(
        Object.fromEntries(
          [...harnesses].map(([hash, paths]) => [hash.slice(0, 8), paths])
        ),
        null,
        1
      )}`
    );
  });

  it("records every red against the production identity the note names", () => {
    // The native run that carries the kept-red PostgreSQL 42883 cell.
    const attempt = JSON.parse(
      readFileSync(join(FOLLOWUP, "native/pg-attempt1/attempt.json"), "utf8")
    ) as { identity: { production: string } };
    assert.equal(
      attempt.identity.production.slice(0, 8),
      "d844ae0f",
      "the native red was recorded at a production identity the note does not name"
    );
  });
});
