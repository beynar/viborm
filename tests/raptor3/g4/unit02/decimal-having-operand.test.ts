/**
 * G4-02 author check — the decimal `having { _sum }` operand domain (§10.10).
 *
 * `having: { amount: { _sum: { gt: x } } }` compares `SUM(amount)`, whose domain
 * is the WIDENED one: a sum may legitimately exceed the column's precision while
 * keeping its scale. Binding the operand in the FIELD's domain (what
 * `lowerOperation`'s `bind` did before phase 2) sends a different literal than
 * the shipped engine for the same public request, and on SQLite — where the
 * column holds an unscaled integer coefficient — a too-narrow cast is a wrong
 * comparison rather than a rounding difference.
 *
 * ## What the C-01 cutover changed here
 *
 * Two of this file's three cells asserted an EQUALITY with the SHIPPED lowering
 * on all three dialects, and reached it through `QueryEngine.build(...)`. The
 * cutover makes `PendingOperation.buildStatement()` answer `undefined` for
 * every operation (divergence D-4': the prepared read owns a statement but
 * publishes only the read's shape and cardinality), so `QueryEngine.build`
 * raises "Operation 'groupBy' does not compile to one SQL statement" and the
 * shipped oracle no longer exists. Under the rule recorded in
 * `g4/cutover-execution/note.md` — remove the shipped arm and every assertion
 * that referenced it, keep a cell iff at least one assertion survives verbatim
 * — those two cells are RETIRED:
 *
 *   "binds the operand exactly as the shipped engine does, on all three dialects"
 *   "binds a sum operand WIDER than the column's own precision, as shipped"
 *
 * The third cell is KEPT: its `assert.match` pins the REGISTERED REFUSAL for a
 * coefficient no provider can cast exactly, one-sidedly, and a registered
 * refusal is a contract. The shipped-side SQL contract those two cells mirrored
 * lives in `tests/contracts/engine/query/decimal-having-operand-sql.core.test.ts`,
 * which the cutover deletes with its engine.
 */

import assert from "node:assert/strict";
import type { DatabaseAdapter } from "@adapters/database-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { EngineSchema } from "@query-engine/raptor3/shared/schema";
import { Queries } from "@query-engine/raptor3/shared/query";
import { hydrateSchemaNames, s } from "@schema";
import { beforeAll, describe, it } from "vitest";

const ledger = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal({ precision: 16, scale: 2 }),
  })
  .map("g4u2_having_ledger");

const schema = { ledger };

beforeAll(() => hydrateSchemaNames(schema));

function candidate(
  adapter: DatabaseAdapter,
  args: Record<string, unknown>
): string {
  const engineSchema = new EngineSchema(schema);
  const queries = new Queries(engineSchema, adapter);
  const admitted = engineSchema.admit(ledger, "groupBy", args);
  return queries.grouped(ledger, admitted).sql.toStatement("$n");
}

const having = (operand: string) => ({
  by: ["bucket"],
  having: { amount: { _sum: { gt: operand } } },
  _count: true,
});

describe("G4-02 decimal having _sum operand (§10.10)", () => {
  it("raises the registered refusal when the provider cannot cast the coefficient", () => {
    // SQLite's exact HAVING operand cast domain is bounded; past it the owner
    // refuses instead of silently changing the value written.
    const args = having("1000000000000000000000000000.00");
    const observe = (build: () => string): string => {
      try {
        return `ok:${build()}`;
      } catch (error) {
        return `error:${(error as Error).message}`;
      }
    };
    const candidateOutcome = observe(() => candidate(new SQLiteAdapter(), args));
    assert.match(
      candidateOutcome,
      /outside this provider's exact HAVING operand cast domain/
    );
  });
});
