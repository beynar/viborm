import { parse } from "@validation";
import { record } from "@validation/primitives/record";
import { string } from "@validation/primitives/string";
import { describe, expect, test } from "vitest";
import { anyValue, rawRecord } from "@src/validation/primitives/raw-record";

/**
 * E5-U3 — the identity-preserving object leaf. Its one property is that the value comes
 * back UNTOUCHED, so a schema can assert an envelope's shape without becoming a parse of
 * what is inside it.
 */
describe("v.rawRecord", () => {
  test("anyValue preserves every representation", () => {
    for (const value of [undefined, null, 1, "value", { nested: true }]) {
      expect(parse(anyValue(), value)).toEqual({ value });
    }
  });

  test("returns the SAME object, by reference", () => {
    const schema = rawRecord();
    const input = { a: 1, nested: { b: [2, 3] } };
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    // Reference equality, not deep equality: a faithful copy would still be a second
    // object, and the arms downstream re-parse what they are given.
    const value = (result as { value: Record<string, unknown> }).value;
    expect(value).toBe(input);
    expect(value.nested).toBe(input.nested);
  });

  test("an empty object passes and is still the same object", () => {
    const schema = rawRecord();
    const input = {};
    const result = parse(schema, input);
    expect(result.issues).toBeUndefined();
    expect((result as { value: Record<string, unknown> }).value).toBe(input);
  });

  test("an array is rejected with the SAME named fact `record` uses", () => {
    const raw = parse(rawRecord(), [1, 2]);
    const dynamic = parse(record(string(), string()), [1, 2]);
    expect(raw.issues?.[0]?.message).toBe("Expected object, received array");
    expect(raw.issues?.[0]?.message).toBe(dynamic.issues?.[0]?.message);
  });

  for (const [label, value] of [
    ["a string", "nope"],
    ["a number", 7],
    ["null", null],
    ["undefined", undefined],
  ] as const) {
    test(`${label} is rejected the way \`record\` rejects it`, () => {
      const raw = parse(rawRecord(), value);
      const dynamic = parse(record(string(), string()), value);
      expect(raw.issues?.[0]?.message).toBe(dynamic.issues?.[0]?.message);
    });
  }
});
