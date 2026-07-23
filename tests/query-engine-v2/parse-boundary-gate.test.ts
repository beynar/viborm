import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The parse-boundary gate (X2 — one home for validation). The typed parse boundary
 * ({@link file://../../src/query-engine-v2/parse-boundary.ts}) is the ONE place a user
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
 *  2. THE THREE DELETED KEY GATES STAY DELETED (negative). X2 deleted `assertCreateKeys`,
 *     `assertDeleteKeys`, `assertUpdateKeys` — each duplicated the schemas' strict +
 *     `atLeast` checks AND ran BEFORE its whole-args validate(), degrading a precise
 *     per-key `ValidationError` into a coarse `UnsupportedOperationError`. Re-adding any of
 *     the three fails here. `assertUpsertKeys` is the ONE surviving key gate — kept
 *     deliberately (X2 conflict): upsert has no whole-args parse (its delegated arms
 *     re-parse the RAW payload, and the update arm's structure must stay deferred), so it
 *     remains upsert's front line. The gate pins EXACTLY that one, in `UpsertOperation.ts`.
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
  "../../src/query-engine-v2"
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
// re-parse the raw payload and its update arm's structure stays deferred (see (2)).
const WHOLE_ARGS_WRITE_OPS = [
  ["CreateOperation.ts", "create"],
  ["UpdateOperation.ts", "update"],
  ["DeleteOperation.ts", "delete"],
] as const;

// The three key gates X2 deleted; `assertUpsertKeys` is the surviving exception.
const DELETED_KEY_GATES = [
  "assertCreateKeys",
  "assertDeleteKeys",
  "assertUpdateKeys",
] as const;

// X2's measured shape-check surface (comments included — a stable, greppable ceiling).
// These may only shrink; growth is a re-introduced re-validation branch.
const MAX_PAYLOAD_RECORD_CASTS = 38;
const MAX_SHAPE_THROW_MESSAGES = 23;

const PARSE_VALIDATED_DEF = /export function parseValidated\b/;
const INFER_OUTPUT_CAST = /as InferOutput\b/;
const KEY_GATE_FUNCTION = /function assert\w*Keys\b/;
const PAYLOAD_RECORD_CAST = /as Record<string, unknown>/g;
const SHAPE_THROW_MESSAGE = /requires an? [^`"']*object|must be an object/g;

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

  it("(3) the three deleted key gates stay deleted; assertUpsertKeys is the lone exception", () => {
    // The only surviving `assert*Keys` is upsert's (the documented conflict).
    const keyGateFiles = engineFiles().filter((file) =>
      KEY_GATE_FUNCTION.test(read(file))
    );
    expect(keyGateFiles).toEqual(["UpsertOperation.ts"]);
    // None of the three deleted gates may reappear anywhere.
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

  it("(ratchet self-check) the current counts equal the pinned ceilings", () => {
    // If a change legitimately reduces the surface, drop the ceiling in lockstep so the
    // ratchet keeps biting at the new floor. This equality tripwire forces that update.
    expect(countAll(PAYLOAD_RECORD_CAST)).toBe(MAX_PAYLOAD_RECORD_CASTS);
    expect(countAll(SHAPE_THROW_MESSAGE)).toBe(MAX_SHAPE_THROW_MESSAGES);
  });
});
