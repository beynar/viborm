/**
 * INDEPENDENT REVIEW — the exact resolution proposed for finding 1.
 *
 * `tests/raptor3/g4/unit02/prepared-projection-reuse.test.ts` imports
 * `PreparedPredicate` as a named type, which `shared/query.ts` declares
 * locally and does not export, so the whole-estate typecheck carries a third
 * diagnostic (TS2459) beyond the two permitted Pattern ones. This cell proves
 * the replacement alias compiles and names the same type, so the author can
 * apply it verbatim without touching a production file.
 */

import assert from "node:assert/strict";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { Queries } from "@query-engine/raptor3/shared/query";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { s } from "@schema";
import { describe, it } from "vitest";

/** The prepared predicate type, read from the one owner that publishes it. */
type PreparedPredicate = NonNullable<
  ReturnType<Queries["prepareSelector"]>["predicate"]
>;

function findIn(
  predicate: PreparedPredicate | undefined
): Extract<PreparedPredicate, { kind: "operation" }> | undefined {
  if (!predicate) return undefined;
  if (predicate.kind === "operation")
    return predicate.operator === "in" ? predicate : undefined;
  if (predicate.kind === "and" || predicate.kind === "or") {
    for (const member of predicate.predicates) {
      const found = findIn(member);
      if (found) return found;
    }
  }
  if (predicate.kind === "not") return findIn(predicate.predicate);
  return undefined;
}

describe("review/perf2 — the TS2459 resolution", () => {
  it("names the same predicate type without importing a local declaration", () => {
    const account = s
      .model({ id: s.int().id(), label: s.string() })
      .map("g4_review_perf2_resolution");
    const queries = new Queries(
      new EngineSchema({ account }),
      new SQLiteAdapter()
    );
    const selector = queries.prepareSelector(account, { id: { in: [1, 2, 3] } });
    const operation = findIn(selector.predicate);
    assert.ok(operation, "the alias did not resolve the `in` operation");
    assert.equal(Object.isFrozen(operation), true);
    assert.equal(Object.isFrozen(operation.operands), true);
    assert.deepEqual(
      operation.operands?.map((operand) =>
        operand.kind === "value" ? operand.value : "field"
      ),
      [1, 2, 3]
    );
  });
});
