/**
 * Review probe. Claim under attack: the generated campaign is "the fastest
 * whole-envelope probe there is" (handoff §1) over "a scalar-rich model with
 * every codec and list type" (witness note §4), and a 100-seed shipped child
 * "validates the oracle" on 200 cells.
 *
 * The probe asks what the campaign can actually OBSERVE. It walks a large seed
 * sample, evaluates the oracle, and classifies every published scalar of every
 * published row. If no Date, bigint, Decimal, byte array, JSON object or array
 * value is ever published, the campaign cannot detect a decode defect in any of
 * those domains no matter how many seeds it runs.
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { generateG4Recipe } from "../../generation/recipe";
import { evaluateRecipe } from "../../generation/oracle";
import { generateRows } from "../../generation/world";

const FIRST = 20_000;

function classify(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (value instanceof Date) return "Date";
  if (ArrayBuffer.isView(value)) return "bytes";
  if (typeof value === "bigint") return "bigint";
  if (value !== null && typeof value === "object") {
    if (typeof (value as { toFixed?: unknown }).toFixed === "function")
      return "Decimal";
    return "object";
  }
  return typeof value;
}

function scalarsOf(value: unknown, into: Map<string, Set<string>>): void {
  if (Array.isArray(value)) {
    for (const member of value) scalarsOf(member, into);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, member] of Object.entries(value as Record<string, unknown>)) {
    const kind = classify(member);
    const bucket = into.get(key) ?? new Set<string>();
    bucket.add(kind);
    into.set(key, bucket);
    if (kind === "object" || kind === "array") scalarsOf(member, into);
  }
}

describe("review probe: what the generated campaign can observe", () => {
  it("never publishes a Date, bigint, Decimal, byte array or JSON document", () => {
    const observed = new Map<string, Set<string>>();
    for (let offset = 0; offset < 500; offset++) {
      const recipe = generateG4Recipe(FIRST + offset, FIRST);
      const rows = generateRows(recipe.seed, recipe.rowCount);
      scalarsOf(evaluateRecipe(recipe, rows), observed);
    }
    const kinds = new Set<string>();
    for (const bucket of observed.values())
      for (const kind of bucket) kinds.add(kind);
    const codecKinds = [...kinds].filter((kind) =>
      ["Date", "bigint", "Decimal", "bytes"].includes(kind)
    );
    assert.deepEqual(
      codecKinds,
      [],
      `the campaign does publish codec-bearing values: ${codecKinds.join(", ")}`
    );
    // Publishable field names, for the record.
    assert.deepEqual(
      [...observed.keys()].sort(),
      [
        "_all",
        "_count",
        "_max",
        "_min",
        "_sum",
        "code",
        "count",
        "id",
        "items",
        "label",
        "name",
        "note",
        "region",
        "score",
        "size",
        "status",
        "weight",
      ],
      "the campaign's publishable surface changed"
    );
  });
});
