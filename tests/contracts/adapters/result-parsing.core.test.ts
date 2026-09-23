/**
 * Unit tests for shared result parsing utilities
 *
 * `convertBigIntToNumber` and `normalizeCountResult` were deleted with the two
 * adapter legs that called them (Arnaud's D-40), so the facts their cells
 * pinned are pinned where those facts actually live, and the cells moved with
 * them rather than being dropped:
 *
 * - "which column carries a count", and the refusal of every other column, is
 *   the decoder's — it asks for the alias `_count` and reads `_count` back:
 *   `tests/contracts/engine/query/parity-decoding.core.test.ts`, "the adapter
 *   result seam decides nothing (D-40)", which answers over the raw measured
 *   live on both providers and fails closed on the two keys the helper used to
 *   recognise and produce;
 * - "a bigint becomes a number", with the safe-range refusal the helper did not
 *   have, is the `int` codec's, pinned by the same two cells;
 * - the adapters' own `parseResult` surface, now the contract's pass-through on
 *   all three dialects, is pinned once at the adapter seam:
 *   `tests/contracts/adapters/internals-and-geo.core.test.ts`.
 */

import {
  COUNT_RESULT_KEY,
  parseIntegerBoolean,
  tryParseJsonString,
} from "@src/adapters/shared/result-parsing";

describe("tryParseJsonString", () => {
  test("parses valid JSON array", () => {
    expect(tryParseJsonString("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  test("parses valid JSON object", () => {
    expect(tryParseJsonString('{"a": 1}')).toEqual({ a: 1 });
  });

  test("handles whitespace around JSON", () => {
    expect(tryParseJsonString("  [1, 2]  ")).toEqual([1, 2]);
    expect(tryParseJsonString("\n{}\n")).toEqual({});
  });

  test("returns undefined for non-string values", () => {
    expect(tryParseJsonString(123)).toBeUndefined();
    expect(tryParseJsonString(null)).toBeUndefined();
    expect(tryParseJsonString(undefined)).toBeUndefined();
    expect(tryParseJsonString({})).toBeUndefined();
    expect(tryParseJsonString([])).toBeUndefined();
  });

  test("returns undefined for non-JSON strings", () => {
    expect(tryParseJsonString("hello")).toBeUndefined();
    expect(tryParseJsonString("")).toBeUndefined();
    expect(tryParseJsonString("123")).toBeUndefined();
  });

  test("returns undefined for invalid JSON", () => {
    expect(tryParseJsonString("[invalid")).toBeUndefined();
    expect(tryParseJsonString("{broken}")).toBeUndefined();
    expect(tryParseJsonString("[1, 2,]")).toBeUndefined();
  });

  test("handles nested JSON", () => {
    const nested = '{"users": [{"id": 1}, {"id": 2}]}';
    expect(tryParseJsonString(nested)).toEqual({
      users: [{ id: 1 }, { id: 2 }],
    });
  });
});

describe("parseIntegerBoolean", () => {
  test("converts 1 to true", () => {
    expect(parseIntegerBoolean(1)).toBe(true);
  });

  test("converts 0 to false", () => {
    expect(parseIntegerBoolean(0)).toBe(false);
  });

  test("converts SQLite bigint boolean carriers", () => {
    expect(parseIntegerBoolean(1n)).toBe(true);
    expect(parseIntegerBoolean(0n)).toBe(false);
  });

  test("returns null for null/undefined", () => {
    expect(parseIntegerBoolean(null)).toBe(null);
    expect(parseIntegerBoolean(undefined)).toBe(null);
  });

  test("returns undefined for non-number values (fall through)", () => {
    expect(parseIntegerBoolean("true")).toBeUndefined();
    expect(parseIntegerBoolean("1")).toBeUndefined();
    expect(parseIntegerBoolean(true)).toBeUndefined();
    expect(parseIntegerBoolean({})).toBeUndefined();
  });

  test("rejects integer values outside the boolean domain", () => {
    expect(parseIntegerBoolean(2)).toBeUndefined();
    expect(parseIntegerBoolean(-1)).toBeUndefined();
    expect(parseIntegerBoolean(2n)).toBeUndefined();
  });
});

describe("COUNT_RESULT_KEY", () => {
  test("is the expected value", () => {
    expect(COUNT_RESULT_KEY).toBe("0viborm_count_result");
  });
});
