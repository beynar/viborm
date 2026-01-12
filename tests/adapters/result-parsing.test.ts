/**
 * Unit tests for shared result parsing utilities
 */

import {
  COUNT_RESULT_KEY,
  convertBigIntToNumber,
  normalizeCountResult,
  parseIntegerBoolean,
  tryParseJsonString,
} from "../../src/adapters/shared/result-parsing";

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

  test("converts other numbers to boolean (truthy check)", () => {
    expect(parseIntegerBoolean(2)).toBe(false); // Only 1 is true
    expect(parseIntegerBoolean(-1)).toBe(false);
  });
});

describe("convertBigIntToNumber", () => {
  test("converts bigint to number", () => {
    expect(convertBigIntToNumber(5n)).toBe(5);
    expect(convertBigIntToNumber(0n)).toBe(0);
    expect(convertBigIntToNumber(BigInt(100))).toBe(100);
  });

  test("returns undefined for non-bigint values", () => {
    expect(convertBigIntToNumber(5)).toBeUndefined();
    expect(convertBigIntToNumber("5")).toBeUndefined();
    expect(convertBigIntToNumber(null)).toBeUndefined();
  });
});

describe("normalizeCountResult", () => {
  test("normalizes COUNT(*) column name (uppercase)", () => {
    const result = normalizeCountResult([{ "COUNT(*)": 5 }]);
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 5 }]);
  });

  test("normalizes count column name (lowercase)", () => {
    const result = normalizeCountResult([{ count: 10 }]);
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 10 }]);
  });

  test("normalizes count(*) column name (lowercase with parens)", () => {
    const result = normalizeCountResult([{ "count(*)": 3 }]);
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 3 }]);
  });

  test("handles COUNT(DISTINCT x) variants", () => {
    const result = normalizeCountResult([{ "COUNT(DISTINCT id)": 7 }]);
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 7 }]);
  });

  test("handles single object (non-array)", () => {
    const result = normalizeCountResult({ "COUNT(*)": 2 });
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 2 }]);
  });

  test("returns undefined for non-count results", () => {
    expect(normalizeCountResult([{ name: "Alice" }])).toBeUndefined();
    expect(normalizeCountResult([{ id: 1, name: "Bob" }])).toBeUndefined();
  });

  test("returns undefined for empty array", () => {
    expect(normalizeCountResult([])).toBeUndefined();
  });

  test("returns undefined for non-object values", () => {
    expect(normalizeCountResult(null)).toBeUndefined();
    expect(normalizeCountResult(undefined)).toBeUndefined();
    expect(normalizeCountResult(5)).toBeUndefined();
    expect(normalizeCountResult("count")).toBeUndefined();
  });

  test("preserves bigint values", () => {
    const result = normalizeCountResult([{ "COUNT(*)": 5n }]);
    expect(result).toEqual([{ [COUNT_RESULT_KEY]: 5n }]);
  });
});

describe("COUNT_RESULT_KEY", () => {
  test("is the expected value", () => {
    expect(COUNT_RESULT_KEY).toBe("_result");
  });
});
