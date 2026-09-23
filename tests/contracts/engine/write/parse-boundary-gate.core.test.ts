import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SOURCE_ROOT } from "@tests/fixtures/repo-paths";
import { describe, expect, it } from "vitest";

/**
 * The parse-boundary gate (X2 — one home for validation). The typed parse boundary
 * ({@link file://../../src/query-engine/raptor3/shared/parse-boundary.ts}) is the ONE place a
 * user payload becomes a validated, typed value. This gate holds three invariants over the
 * ROUTE that owns it and fails loudly if a future phase erodes them.
 *
 * F-2 moved the boundary into `raptor3/shared/` and deleted `write-engine/`, so the scope
 * follows it: `ENGINE` is the whole `raptor3/` route, walked RECURSIVELY (the route has
 * `commands/`, `route/` and `shared/` under it; the flat `readdirSync` the
 * write-engine scope used would have read nothing). The two ratchets below are therefore
 * RE-MEASURED over the new scope, not carried over — carrying them would have kept
 * ceilings measured over 18 deleted files, which is exactly why they passed for the wrong
 * reason once `write-engine/` held one file (retirement note F-3).
 *
 *  1. ONE HOME (positive). `parseValidated` is defined exactly once (parse-boundary.ts)
 *     and the lone whole-tree `as InferOutput` cast — the only assertion inference
 *     cannot reach — lives only there.
 *
 *  2. NO KEY GATE SURVIVES (negative). X2 deleted `assertCreateKeys`, `assertDeleteKeys`,
 *     `assertUpdateKeys` — each duplicated the schemas' strict + `atLeast` checks AND ran
 *     BEFORE its whole-args validate(), degrading a precise per-key `ValidationError` into
 *     a coarse `UnsupportedOperationError`. Re-adding any of the three fails here.
 *     `assertUpsertKeys` was the ONE documented exception, and E5-U3 removed it, so the
 *     expectation is the EMPTY list: any `assert*Keys` anywhere fails here now.
 *
 *  3. RATCHET (growth fails). The in-engine shape-check surface — payload
 *     `as Record<string, unknown>` narrowings and `requires a … object` / `must be an
 *     object` throw messages — may only SHRINK. Pinning the counts as ceilings means a
 *     future phase that re-introduces a re-validation branch (a new requireRecord throw,
 *     a new payload cast) trips this gate, while a legitimate reduction is free.
 *
 * C-01 deleted the per-operation owners this file also gated: the whole-args wiring cell
 * (`CreateOperation.ts` / `UpdateOperation.ts` / `DeleteOperation.ts`), the upsert-envelope
 * cell (`routing.ts`) and the ratchet's equality self-check, whose pinned counts were
 * measured over the deleted modules. The three invariants above are unchanged and are
 * measured over the modules that remain.
 *
 * Falsified: (1) re-add `function assertCreateKeys` -> test (3) fails; (2) add one payload
 * `as Record<string, unknown>` -> the count exceeds the ceiling -> test (4) fails.
 */

const ENGINE = join(SOURCE_ROOT, "query-engine/raptor3");
const BOUNDARY = "shared/parse-boundary.ts";

/** Every `.ts` under the route, as a path relative to {@link ENGINE}. */
function engineFiles(): string[] {
  function walk(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return walk(path);
      return entry.name.endsWith(".ts") ? [path] : [];
    });
  }
  return walk(ENGINE)
    .map((path) => path.slice(ENGINE.length + 1))
    .sort();
}

function read(file: string): string {
  return readFileSync(join(ENGINE, file), "utf8");
}

function countAll(pattern: RegExp): number {
  let total = 0;
  for (const file of engineFiles()) {
    total += (read(file).match(pattern) ?? []).length;
  }
  return total;
}

// The key gates X2 deleted, plus `assertUpsertKeys` — the exception it kept, which
// E5-U3 removed when the envelope moved to the boundary.
const DELETED_KEY_GATES = [
  "assertCreateKeys",
  "assertDeleteKeys",
  "assertUpdateKeys",
  "assertUpsertKeys",
] as const;

// The shape-check surface, RE-MEASURED over `raptor3/` on the tree that moved the
// boundary (F-2). Both counts are 1, and both hits are in the boundary's own prose —
// the sentence naming `as Record<string, unknown>` as the thing a future phase must not
// re-introduce, and the sentence naming the `requires a … object` guards it replaced.
// Comments are counted on purpose: the ceiling is a stable, greppable one, and prose
// that names the forbidden shape is cheaper to keep than an exception for it.
//
// The route's own 15 files contribute ZERO of each: no emitter re-opens a payload and no
// owner re-checks a shape, because admission happens once at the boundary and everything
// downstream reads canonical entries. So the ceiling is the boundary's prose and nothing
// else: ONE new cast or ONE new shape-check message anywhere under `raptor3/` reddens
// this gate.
//
// The write-engine-era history of these two numbers (38 -> 3 over X2, W4-U3, N4-U2, the
// D-wave, the mutation-program migration, field-bound source lowering, compound-junction
// tuple lowering and the two fixed-decimal decode rounds) belongs to the 18 files D-15
// deleted; it is preserved in the pattern-retirement note, not carried here as a ceiling
// no longer measured over anything.
const MAX_PAYLOAD_RECORD_CASTS = 1;
const MAX_SHAPE_THROW_MESSAGES = 1;

const PARSE_VALIDATED_DEF = /export function parseValidated\b/;
const INFER_OUTPUT_CAST = /as InferOutput\b/;
const KEY_GATE_FUNCTION = /function assert\w*Keys\b/;
const PAYLOAD_RECORD_CAST = /as Record<string, unknown>/g;
const SHAPE_THROW_MESSAGE = /requires an? [^`"']*object|must be an object/g;

describe("route parse-boundary gate (X2 — one home for validation)", () => {
  it("(1) parseValidated is defined once — in the boundary — with the lone whole-tree cast", () => {
    const definers = engineFiles().filter((file) =>
      PARSE_VALIDATED_DEF.test(read(file))
    );
    expect(definers).toEqual([BOUNDARY]);
    // The only `as InferOutput` in the engine is the boundary's sanctioned parse cast.
    const casters = engineFiles().filter((file) =>
      INFER_OUTPUT_CAST.test(read(file))
    );
    expect(casters).toEqual([BOUNDARY]);
  });

  it("(3) no key gate survives anywhere — assertUpsertKeys was the last", () => {
    // E5-U3: the documented exception is gone. No `assert*Keys` remains in the engine.
    const keyGateFiles = engineFiles().filter((file) =>
      KEY_GATE_FUNCTION.test(read(file))
    );
    expect(keyGateFiles).toEqual([]);
    // …and none of the four named gates may reappear.
    const revived = DELETED_KEY_GATES.filter((gate) =>
      engineFiles().some((file) => read(file).includes(`function ${gate}`))
    );
    expect(revived).toEqual([]);
  });

  it("(4) the in-engine shape-check surface may only shrink (X2 ratchet)", () => {
    expect(countAll(PAYLOAD_RECORD_CAST)).toBeLessThanOrEqual(
      MAX_PAYLOAD_RECORD_CASTS
    );
    expect(countAll(SHAPE_THROW_MESSAGE)).toBeLessThanOrEqual(
      MAX_SHAPE_THROW_MESSAGES
    );
  });
});
