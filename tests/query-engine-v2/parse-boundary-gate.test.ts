import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The parse-boundary gate (X2 — one home for validation). The typed parse boundary
 * ({@link file://../../src/query-engine/write-engine/parse-boundary.ts}) is the ONE place a user
 * payload becomes a validated, typed value; every write operation's whole-args legality
 * flows through it. This gate holds three invariants and fails loudly if a future phase
 * erodes them.
 *
 *  1. ONE HOME (positive). `parseValidated` is defined exactly once (parse-boundary.ts),
 *     the lone whole-tree `as InferOutput` cast — the only assertion inference cannot
 *     reach — lives only there, and each of the three single-record write operations that
 *     CAN (create/update/delete) validates its WHOLE args through it
 *     (`parseValidated(parentSchemas.args.<op>, …)`). Deleting one of those parses fails
 *     here. (`upsert` is the documented exception — see (2).)
 *
 *  2. NO KEY GATE SURVIVES (negative). X2 deleted `assertCreateKeys`, `assertDeleteKeys`,
 *     `assertUpdateKeys` — each duplicated the schemas' strict + `atLeast` checks AND ran
 *     BEFORE its whole-args validate(), degrading a precise per-key `ValidationError` into
 *     a coarse `UnsupportedOperationError`. Re-adding any of the three fails here.
 *     `assertUpsertKeys` was the ONE documented exception, and E5-U3 removed it: upsert
 *     still has no whole-args parse — its delegated arms re-parse the RAW payload and the
 *     untaken arm's CONTENT stays deferred — but neither reason is about the ENVELOPE, so
 *     the envelope became a model-blind schema at the boundary
 *     ({@link file://../../src/query-engine/write-engine/parse-boundary.ts},
 *     `upsertEnvelopeSchema`: three required keys, five optional names, the arms' object-
 *     ness, no transform, no descent) wired at the one construction path (`routing.ts`).
 *     The class moved with it: `UnsupportedOperationError` (V8003, no prismaCode) →
 *     `ValidationError` (P2009). The exception this test documented is GONE, so the
 *     expectation is the EMPTY list: any `assert*Keys` anywhere fails here now.
 *
 *  3. RATCHET (growth fails). The in-engine shape-check surface — payload
 *     `as Record<string, unknown>` narrowings and `requires a … object` / `must be an
 *     object` throw messages — may only SHRINK. X2 left a bounded residue of
 *     `unknown -> Record` narrowings on dynamic relation-index paths (`data[relationName]`
 *     / `spec.create` widen to `unknown`); their clean removal needs a type refactor
 *     threading precise parsed types through `interpretRelation` and the Part builders,
 *     deferred past X2. Pinning the counts as ceilings means a future phase that
 *     re-introduces a re-validation branch (a new requireRecord throw, a new payload cast)
 *     trips this gate, while the deferred refactor is free to reduce it.
 *
 * Falsified: (1) delete `parseValidated(parentSchemas.args.delete, …)` -> test 2 fails;
 * (2) re-add `function assertCreateKeys` -> test 3 fails (two key gates, not one); (3) add
 * one payload `as Record<string, unknown>` -> the count exceeds the ceiling -> test 4 fails.
 */

const ENGINE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../src/query-engine/write-engine"
);
const BOUNDARY = "parse-boundary.ts";

function engineFiles(): string[] {
  return readdirSync(ENGINE).filter((file) => file.endsWith(".ts"));
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

// The single-record write ops that validate their whole payload through the boundary
// (`parentSchemas.args.<op>`). `upsert` is deliberately absent — its delegated arms
// re-parse the raw payload and its update arm's CONTENT stays deferred, so what moved to
// the boundary (E5-U3) is its ENVELOPE, through a model-blind schema rather than a
// per-model `args.upsert` (see (2)).
const WHOLE_ARGS_WRITE_OPS = [
  ["CreateOperation.ts", "create"],
  ["UpdateOperation.ts", "update"],
  ["DeleteOperation.ts", "delete"],
] as const;

// The key gates X2 deleted, plus `assertUpsertKeys` — the exception it kept, which
// E5-U3 removed when the envelope moved to the boundary.
const DELETED_KEY_GATES = [
  "assertCreateKeys",
  "assertDeleteKeys",
  "assertUpdateKeys",
  "assertUpsertKeys",
] as const;

// X2's measured shape-check surface (comments included — a stable, greppable ceiling).
// These may only shrink; growth is a re-introduced re-validation branch.
// 38 -> 37 / 23 -> 22 (W4-U3 fix round): the to-one `update` payload now arrives as
// the relation schema's canonical envelope, so `buildToOneUpdatePart` no longer
// re-checks its shape or casts it — the split reads the envelope and fails closed.
// 37 -> 36 (N4-U2): `foldParentHeldConnect` is gone. It hand-read a grandchild's nested
// `connect` payload — the one thing the create root does not need a cast for, because a
// create SUBTREE folds that connect through the same already-parsed relation mutation
// every other arm uses. The cast went with the function, not around it.
// 36 -> 35 (D-wave): `buildInverseToOneUpsertPart` replaced its two arm casts with an
// `isRecord` narrowing predicate (the sibling modules' idiom), so the M12 owned-FK guard
// could take the update arm without a new cast — the surface shrank by one instead of
// growing by one.
// 35 -> 18 (mutation-program migration): emitters now receive normalized entries instead
// of reopening dynamically keyed relation payloads. The casts disappeared with the old
// per-kind bag readers and their local array/single-item normalizers.
// 18 -> 16 (field-bound source lowering): relation consumers no longer recast captured
// planning rows to recover a field selected outside the source owner.
const MAX_PAYLOAD_RECORD_CASTS = 15;
// 22 -> 21 (N4-U2): the same removal. `foldParentHeldConnect`'s "requires a where object
// one level deeper" was the shape-check message that went with that cast.
// 21 -> 20 (E3): `RelationUpsertPart.normalizeUpsertItems` went with the upsert arm's
// kind dispatch. The arm no longer unwraps a deeper relation's item array itself — it
// hands the whole relation map to the located-target builder, whose own `normalizeItems`
// already owns that narrowing. One home gained, one message gone; the ratchet shrinks
// rather than moving sideways.
// 20 -> 19 (E5-U3): `UpsertOperation.requireRecord` is gone. Its "must be an object"
// was the last shape-check message on an envelope; the envelope is a schema now, and the
// narrowing that replaced it is a `QueryEngineError` invariant worded outside this
// family on purpose (a caller that skipped the boundary is an engine fault, not a user
// one). Measured delta, not estimated: the source carried the phrase exactly once.
// 19 -> 3 (mutation-program migration): canonical entries replace emitter-side payload
// shape checks. The remaining messages belong to live parse-boundary invariants.
const MAX_SHAPE_THROW_MESSAGES = 3;

const PARSE_VALIDATED_DEF = /export function parseValidated\b/;
const INFER_OUTPUT_CAST = /as InferOutput\b/;
const KEY_GATE_FUNCTION = /function assert\w*Keys\b/;
const PAYLOAD_RECORD_CAST = /as Record<string, unknown>/g;
const SHAPE_THROW_MESSAGE = /requires an? [^`"']*object|must be an object/g;
const UPSERT_ENVELOPE_DEF = /export const upsertEnvelopeSchema\b/;
const UPSERT_ENVELOPE_PARSE = /parseValidated\(\s*upsertEnvelopeSchema\b/;

describe("query-engine-v2 parse-boundary gate (X2 — one home for validation)", () => {
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

  it("(2) create/update/delete validate their whole args through the boundary", () => {
    const unwired = WHOLE_ARGS_WRITE_OPS.filter(([file, op]) => {
      const wholeArgsParse = new RegExp(
        `parseValidated\\(\\s*parentSchemas\\.args\\.${op}\\b`
      );
      return !wholeArgsParse.test(read(file));
    });
    expect(unwired).toEqual([]);
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

  it("(5) the upsert envelope is a schema at the boundary, wired at the one construction path", () => {
    // The positive half of (3): deleting the key gate is only an improvement if the
    // envelope moved. It is defined in the boundary and parsed in `routing.ts`, once.
    expect(read("parse-boundary.ts")).toMatch(UPSERT_ENVELOPE_DEF);
    expect(read("routing.ts")).toMatch(UPSERT_ENVELOPE_PARSE);
    expect(
      engineFiles().filter((file) => UPSERT_ENVELOPE_PARSE.test(read(file)))
    ).toEqual(["routing.ts"]);
  });

  it("(4) the in-engine shape-check surface may only shrink (X2 ratchet)", () => {
    expect(countAll(PAYLOAD_RECORD_CAST)).toBeLessThanOrEqual(
      MAX_PAYLOAD_RECORD_CASTS
    );
    expect(countAll(SHAPE_THROW_MESSAGE)).toBeLessThanOrEqual(
      MAX_SHAPE_THROW_MESSAGES
    );
  });

  it("(ratchet self-check) the current counts equal the pinned ceilings", () => {
    // If a change legitimately reduces the surface, drop the ceiling in lockstep so the
    // ratchet keeps biting at the new floor. This equality tripwire forces that update.
    expect(countAll(PAYLOAD_RECORD_CAST)).toBe(MAX_PAYLOAD_RECORD_CASTS);
    expect(countAll(SHAPE_THROW_MESSAGE)).toBe(MAX_SHAPE_THROW_MESSAGES);
  });
});
