/**
 * Review probe — G4 harness reconciliation, the CS-03 `lookupWhere` repair.
 *
 * The unit widened one recognizer in each CS-03 scenario file from
 * `/WHERE[\s\S]*"lookup"\s*=/` so it can read the `COLLATE` the adapter's
 * exact-text operator now names. The first round wrote `(?:"[^"]+"|\w+)`
 * there — any collation, including the case-INSENSITIVE one; after review
 * finding 4 it reads `(?:BINARY|"C")`, the two byte-exact spellings.
 *
 * The recognizers are module-local `const`s, so this probe does not keep a
 * copy of them: it reads the literal out of the scenario sources, which makes
 * every assertion below a statement about the harness that actually runs, and
 * makes a silent re-widening (or a second divergent copy) fail here.
 *
 * The corpus is taken verbatim from the unit's own two recorder tapes
 * (`g4/witness/receipts/reconciliation/cut-tapes-*.json`), plus negatives the
 * author did not state. It pins three things:
 *   1. the live recognizer reads BOTH spellings (so it was not tuned to this
 *      month's engine — the same claim as the author's baseline re-run);
 *   2. the OLD recognizer is blind to the current spelling (so the ten reds
 *      really were recognizer staleness, not a lost cut);
 *   3. what it refuses: a non-binding statement, and a collation that is not
 *      byte-exact — a different public filter from exact text equality.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "vitest";

const MEASUREMENT = "/Users/arnaud/code/viborm/tests/raptor3/core-structure/measurement";
const lookupWherePattern = /^const lookupWhere = \/(.+)\/;$/m;

/** The recognizer the named scenario file really compiles, not a copy of it. */
function liveRecognizer(scenario: string): RegExp {
  const source = readFileSync(`${MEASUREMENT}/${scenario}`, "utf8");
  const declaration = lookupWherePattern.exec(source);
  assert.ok(declaration?.[1], `${scenario} declares no lookupWhere literal`);
  return new RegExp(declaration[1]);
}

const OLD = /WHERE[\s\S]*"lookup"\s*=/;
const LIVE_A = liveRecognizer("extension-a-scenario.ts");
const LIVE_COMPOSITION = liveRecognizer("extension-composition-scenario.ts");

/** Slice A, seed 7144, `0cc61e61` src (baseline tape). */
const BASELINE_LOCATE =
  'SELECT "q1"."id" AS "id", "q1"."lookup" AS "lookup" FROM "cs03_a_children" AS "q1" WHERE "q1"."lookup" = ? LIMIT ?';
/** Slice A, seed 7144, current src. */
const CURRENT_LOCATE =
  'SELECT "q1"."id" AS "id", "q1"."lookup" AS "lookup" FROM "cs03_a_children" AS "q1" WHERE "q1"."lookup" COLLATE BINARY = ? ORDER BY "q1"."id" ASC LIMIT ?';
/** Composition, seed 7305, current src. */
const CURRENT_HOLDER_LOCATE =
  'SELECT "q4"."id" AS "id", "q4"."lookup" AS "lookup" FROM "cs03_composition_compound_holders" AS "q4" WHERE "q4"."lookup" COLLATE BINARY = ? ORDER BY "q4"."id" ASC LIMIT ?';
/** The Postgres spelling the repair's own comment claims to cover. */
const POSTGRES_LOCATE =
  'SELECT "q1"."id" AS "id" FROM "cs03_a_children" AS "q1" WHERE "q1"."lookup" COLLATE "C" = $1 LIMIT $2';
/** Root capture: `"lookup"` is in the projection, never bound in the WHERE. */
const ROOT_CAPTURE =
  'SELECT "q0"."id" AS "id", "q0"."lookup" AS "lookup" FROM "cs03_a_nodes" AS "q0" WHERE "q0"."kind" = ? ORDER BY "q0"."id" ASC';

describe("review probe: the repaired CS-03 lookup recognizer", () => {
  it("reads the cut in both tapes, where the old recognizer read only one", () => {
    assert.equal(OLD.test(BASELINE_LOCATE), true);
    assert.equal(OLD.test(CURRENT_LOCATE), false, "the recorded staleness");
    assert.equal(LIVE_A.test(BASELINE_LOCATE), true);
    assert.equal(LIVE_A.test(CURRENT_LOCATE), true);
    assert.equal(LIVE_COMPOSITION.test(CURRENT_HOLDER_LOCATE), true);
    assert.equal(LIVE_A.test(POSTGRES_LOCATE), true);
    assert.equal(LIVE_COMPOSITION.test(POSTGRES_LOCATE), true);
  });

  it("still rejects a statement that does not bind the key", () => {
    assert.equal(LIVE_A.test(ROOT_CAPTURE), false);
    assert.equal(
      LIVE_A.test(
        'SELECT "q1"."id" FROM "t" AS "q1" WHERE "q1"."lookupExtra" = ?'
      ),
      false,
      "a different column whose name merely starts with the key"
    );
    assert.equal(
      LIVE_A.test('SELECT "q1"."id" FROM "t" AS "q1" WHERE "q1"."lookup" LIKE ?'),
      false,
      "a prefix filter is not the locate"
    );
    assert.equal(
      LIVE_A.test('SELECT "q1"."id" FROM "t" AS "q1" ORDER BY "q1"."lookup" ASC'),
      false,
      "an ordering term is not a binding"
    );
  });

  it("admits the byte-exact collations only, in both scenario files", () => {
    // Review finding 4, after the repair: the locate is generated from the
    // operation's own unique key, so it can only be `exactTextEq` today — but
    // a locate that stopped being exact text must fail the recognizer rather
    // than be read as the same cut.
    for (const [name, live] of [
      ["extension-a-scenario.ts", LIVE_A],
      ["extension-composition-scenario.ts", LIVE_COMPOSITION],
    ] as const) {
      assert.equal(
        live.test(
          'SELECT "q1"."id" FROM "t" AS "q1" WHERE "q1"."lookup" COLLATE NOCASE = ?'
        ),
        false,
        `${name} must not read an insensitive collation as this cut`
      );
      assert.equal(
        live.test(
          'SELECT "q1"."id" FROM "t" AS "q1" WHERE "q1"."lookup" COLLATE "und-x-icu" = ?'
        ),
        false,
        `${name} must not read a linguistic collation as this cut`
      );
      assert.equal(live.source, LIVE_A.source, `${name} diverges from slice A`);
    }
  });
});
