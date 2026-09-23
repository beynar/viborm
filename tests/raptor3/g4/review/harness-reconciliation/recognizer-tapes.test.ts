/**
 * Review probe — G4 harness reconciliation, follow-up round (after REVISE).
 *
 * `lookup-recognizer.test.ts` checks the live recognizers against statements
 * copied out of the unit's tapes by hand. This cell checks them against the
 * WHOLE recorded tapes instead — every statement of all nine recorded CS-03
 * cells, in both the `0cc61e61` and the current recording — so the claims below
 * are measured over the real corpus rather than over a chosen excerpt:
 *
 *   1. the narrowed recognizer (`(?:BINARY|"C")`, review finding 4) still reads
 *      EVERY `lookup` binding in BOTH tapes — the narrowing lost no real
 *      statement;
 *   2. the OLD recognizer reads none of the current tape's — the ten reds were
 *      recognizer staleness, exactly as section 18.1 classifies them;
 *   3. `parentId` / `parentTenant` really do carry no collation in either tape,
 *      which is the note's stated reason for leaving those two recognizers
 *      alone. If the engine ever spells them with one, this cell fails and the
 *      unwidened recognizers must be revisited;
 *   4. no statement in either tape carries a collation the narrowed alternation
 *      would now refuse, so narrowing cannot have hidden a live cut.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const EVIDENCE =
  "/Users/arnaud/code/viborm/docs/architecture/raptor3-evidence/g4/witness/receipts/reconciliation";
const MEASUREMENT =
  "/Users/arnaud/code/viborm/tests/raptor3/core-structure/measurement";

interface Tape {
  readonly seed: number;
  readonly statements: readonly { readonly sql: string }[];
}

function tape(file: string): string[] {
  const recorded = JSON.parse(readFileSync(`${EVIDENCE}/${file}`, "utf8")) as Tape[];
  const statements = recorded.flatMap((cell) => cell.statements.map((s) => s.sql));
  assert.ok(statements.length > 0, `${file} recorded no statement`);
  return statements;
}

/** The recognizer the named scenario file really compiles, not a copy of it. */
function liveRecognizer(scenario: string): RegExp {
  const source = readFileSync(`${MEASUREMENT}/${scenario}`, "utf8");
  const declaration = /^const lookupWhere = \/(.+)\/;$/m.exec(source);
  assert.ok(declaration?.[1], `${scenario} declares no lookupWhere literal`);
  return new RegExp(declaration[1]);
}

const CURRENT = tape("cut-tapes-current-src.json");
const BASELINE = tape("cut-tapes-baseline-0cc61e61-src.json");
const LIVE_A = liveRecognizer("extension-a-scenario.ts");
const LIVE_COMPOSITION = liveRecognizer("extension-composition-scenario.ts");
const OLD = /WHERE[\s\S]*"lookup"\s*=/;
const BINDS_LOOKUP = /WHERE[\s\S]*"lookup"/;

describe("review probe: the narrowed recognizer against the whole recorded tapes", () => {
  it("reads every lookup binding in both tapes, where the old one reads only the baseline's", () => {
    for (const [label, statements] of [
      ["current", CURRENT],
      ["baseline 0cc61e61", BASELINE],
    ] as const) {
      const bound = statements.filter((sql) => BINDS_LOOKUP.test(sql));
      assert.ok(bound.length >= 10, `${label}: only ${bound.length} lookup bindings`);
      for (const sql of bound) {
        assert.equal(LIVE_A.test(sql), true, `${label}: slice A recognizer missed ${sql}`);
        assert.equal(
          LIVE_COMPOSITION.test(sql),
          true,
          `${label}: composition recognizer missed ${sql}`
        );
      }
    }
    const currentBound = CURRENT.filter((sql) => BINDS_LOOKUP.test(sql));
    assert.equal(
      currentBound.filter((sql) => OLD.test(sql)).length,
      0,
      "the old recognizer would have read the current tape, so the reds were not staleness"
    );
    const baselineBound = BASELINE.filter((sql) => BINDS_LOOKUP.test(sql));
    assert.equal(baselineBound.filter((sql) => OLD.test(sql)).length, baselineBound.length);
  });

  it("the relation-scope keys carry no collation, which is why their recognizers were left alone", () => {
    for (const [label, statements] of [
      ["current", CURRENT],
      ["baseline 0cc61e61", BASELINE],
    ] as const)
      for (const key of ["parentId", "parentTenant"] as const) {
        const bound = statements.filter((sql) =>
          new RegExp(`WHERE[\\s\\S]*"${key}"`).test(sql)
        );
        for (const sql of bound) {
          assert.doesNotMatch(
            sql,
            new RegExp(`"${key}"\\s+COLLATE`),
            `${label}: ${key} now carries a collation, so its recognizer is blind: ${sql}`
          );
          assert.match(sql, new RegExp(`WHERE[\\s\\S]*"${key}"\\s*=`));
        }
      }
  });

  it("no recorded statement carries a collation the narrowed alternation refuses", () => {
    const admitted = new Set(["BINARY", '"C"']);
    for (const [label, statements] of [
      ["current", CURRENT],
      ["baseline 0cc61e61", BASELINE],
    ] as const)
      for (const sql of statements)
        for (const match of sql.matchAll(/COLLATE\s+("[^"]+"|\w+)/g))
          assert.ok(
            admitted.has(match[1] as string),
            `${label}: a recorded statement collates with ${match[1]}, which the narrowed recognizer refuses: ${sql}`
          );
  });
});
