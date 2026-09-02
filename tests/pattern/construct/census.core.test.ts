/**
 * The construction census (pattern-engine-ideal-state.md §3, §5, §13.7 item 3):
 *
 *  - no storage word in `sugar.ts` or `construct.ts`, other than the K2 field
 *    name `viaJunction` (a `ReferenceCells` field — the one admitted spelling);
 *  - no engine error class in `construct.ts`: it throws only `ValidationError`;
 *  - no nested verb name below the sugar table: `construct.ts` never spells a
 *    verb that is not also a root operation name.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

const here = resolve(__dirname, "../../../src/query-engine/pattern");
const read = (file: string): string =>
  readFileSync(resolve(here, file), "utf8");

// Substring, case-insensitive: `conjunction` and `junctionField` are hits too,
// which is the point — a storage word must not survive under any spelling.
const STORAGE_WORDS = /junction|foreignkey|polymorphic|parentheld|childheld/i;
const ADMITTED_FIELD = /viaJunction/g;
// Error TEXT is not a branch: a line that reproduces today's byte-identical
// message may name a storage word when it says so. The exemption is per line
// and must be explicit; it never covers a decision.
const ERROR_TEXT_LINE = /^.*\/\/ census: error-text\s*$/gm;
// The class NAME may appear only as the `DeferredRefusal.error` label; never
// imported, never constructed.
const ENGINE_ERRORS =
  /(import[^;]*|new\s+)(QueryEngineError|NestedWriteError|UnsupportedOperationError)/;
const NESTED_ONLY_VERBS = /"(connect|disconnect|connectOrCreate)"/;
const THROWS = /throw new (\w+)/g;
const CONNECT_OR_CREATE = /"connectOrCreate"/;
const MESSAGE_LINE = /message: `|^\s*[?:] "|^\s*\? "/;

describe("construction census", () => {
  test.each([
    "sugar.ts",
    "construct.ts",
  ])("%s spells no storage word", (file) => {
    const source = read(file)
      .replace(ERROR_TEXT_LINE, "")
      .replace(ADMITTED_FIELD, "");
    const hit = STORAGE_WORDS.exec(source);
    expect(hit ? `${file}: ${hit[0]} at ${hit.index}` : "").toBe("");
  });

  test("construct.ts names no engine error class", () => {
    expect(ENGINE_ERRORS.test(read("construct.ts"))).toBe(false);
  });

  test("the error-text exemption covers only message lines", () => {
    const exempt = read("construct.ts").match(ERROR_TEXT_LINE) ?? [];
    expect(exempt.length).toBeGreaterThan(0);
    for (const line of exempt) {
      expect(line).toMatch(MESSAGE_LINE);
    }
  });

  test("construct.ts throws only ValidationError (and an unreachable TypeError)", () => {
    const thrown = [...read("construct.ts").matchAll(THROWS)].map((m) => m[1]);
    expect(new Set(thrown)).toEqual(new Set(["ValidationError", "TypeError"]));
  });

  test("construct.ts spells no nested-only verb", () => {
    expect(NESTED_ONLY_VERBS.test(read("construct.ts"))).toBe(false);
  });

  test("sugar.ts is the only pattern module that spells the verbs", () => {
    expect(read("sugar.ts")).toMatch(CONNECT_OR_CREATE);
    for (const file of ["pattern.ts", "cells.ts", "construct.ts"]) {
      expect(read(file)).not.toMatch(CONNECT_OR_CREATE);
    }
  });
});
