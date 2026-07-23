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
 *     reach — lives only there, and each single-record write operation
 *     (create/update/delete/upsert) validates its WHOLE args through it
 *     (`parseValidated(parentSchemas.args.<op>, …)`). Deleting a write op's whole-args
 *     parse — the exact gap X2 closed for `upsert`, which had none — fails here.
 *
 *  2. NO PRE-VALIDATE KEY GATE (negative). The four `assert*Keys` gates X2 deleted
 *     duplicated the schemas' strict + `atLeast` checks AND ran BEFORE validate(),
 *     degrading a precise per-key `ValidationError` into a coarse
 *     `UnsupportedOperationError`. No such gate may return: no `assert*Keys` function, no
 *     `… arguments require … (optional …` pre-validate message. Re-adding
 *     `assertUpsertKeys` fails here.
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
 * Falsified: (1) delete `parseValidated(parentSchemas.args.upsert, …)` -> test 2 fails;
 * (2) re-add `function assertUpsertKeys` -> test 3 fails; (3) add one payload
 * `as Record<string, unknown>` -> the count exceeds the ceiling -> test 4 fails.
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

// The single-record write operations and the operation-name segment of the args schema
// each must validate its whole payload against (`parentSchemas.args.<op>`).
const WHOLE_ARGS_WRITE_OPS = [
  ["CreateOperation.ts", "create"],
  ["UpdateOperation.ts", "update"],
  ["DeleteOperation.ts", "delete"],
  ["UpsertOperation.ts", "upsert"],
] as const;

// X2's measured shape-check surface (comments included — a stable, greppable ceiling).
// These may only shrink; growth is a re-introduced re-validation branch.
const MAX_PAYLOAD_RECORD_CASTS = 38;
const MAX_SHAPE_THROW_MESSAGES = 22;

describe("query-engine-v2 parse-boundary gate (X2 — one home for validation)", () => {
  it("(1) parseValidated is defined once — in the boundary — with the lone whole-tree cast", () => {
    const definers = engineFiles().filter((file) =>
      /export function parseValidated\b/.test(read(file))
    );
    expect(definers).toEqual([BOUNDARY]);
    // The only `as InferOutput` in the engine is the boundary's sanctioned parse cast.
    const casters = engineFiles().filter((file) =>
      /as InferOutput\b/.test(read(file))
    );
    expect(casters).toEqual([BOUNDARY]);
  });

  it("(2) each single-record write op validates its whole args through the boundary", () => {
    const unwired = WHOLE_ARGS_WRITE_OPS.filter(([file, op]) => {
      // biome-ignore lint/performance/useTopLevelRegex: one per write op, built rarely
      const wholeArgsParse = new RegExp(
        `parseValidated\\(\\s*parentSchemas\\.args\\.${op}\\b`
      );
      return !wholeArgsParse.test(read(file));
    });
    expect(unwired).toEqual([]);
  });

  it("(3) no pre-validate key gate returns (assert*Keys / 'arguments require' message)", () => {
    const offenders = engineFiles().filter((file) => {
      const source = read(file);
      return (
        /function assert\w*Keys\b/.test(source) ||
        /arguments require .+\(optional/.test(source)
      );
    });
    expect(offenders).toEqual([]);
  });

  it("(4) the in-engine shape-check surface may only shrink (X2 ratchet)", () => {
    const payloadRecordCasts = countAll(/as Record<string, unknown>/g);
    const shapeThrowMessages = countAll(
      /requires an? [^`"']*object|must be an object/g
    );
    expect(payloadRecordCasts).toBeLessThanOrEqual(MAX_PAYLOAD_RECORD_CASTS);
    expect(shapeThrowMessages).toBeLessThanOrEqual(MAX_SHAPE_THROW_MESSAGES);
  });

  it("(ratchet self-check) the current counts equal the pinned ceilings", () => {
    // If a change legitimately reduces the surface, drop the ceiling in lockstep so the
    // ratchet keeps biting at the new floor. This equality tripwire forces that update.
    expect(countAll(/as Record<string, unknown>/g)).toBe(MAX_PAYLOAD_RECORD_CASTS);
    expect(countAll(/requires an? [^`"']*object|must be an object/g)).toBe(
      MAX_SHAPE_THROW_MESSAGES
    );
  });
});
