import {
  isKey,
  keyBetween,
  keysBetween,
  MAX_KEY_LENGTH,
} from "@src/ordering/keys";
import { describe, expect, test } from "vitest";

const ascending = (keys: readonly string[]) =>
  keys.every((key, index) => index === 0 || (keys[index - 1] as string) < key);

describe("ordering keys: grammar", () => {
  test.each([
    ["10", true],
    ["15", true],
    ["19", true],
    ["210", true],
    ["299", true],
    ["15", true],
    ["155", true],
    ["1505", true],
    ["089", true],
    ["081", true],
    ["0790", true],
    ["0701", true],
    ["06900", true],
  ])("%s is a key", (key, expected) => {
    expect(isKey(key)).toBe(expected);
  });

  test.each([
    ["", "empty"],
    ["1", "integer part cut short"],
    ["2", "integer part cut short"],
    ["21", "integer part cut short"],
    ["205", "leading zero in a positive integer"],
    ["150", "trailing zero in the fraction"],
    ["1a", "a letter"],
    ["1 5", "a space"],
    ["09", "negative head 9 has no length"],
    ["080", "negative body 0 is not a value"],
    ["0700", "negative body 00 is not a value"],
    ["0791", "negative body above 9 x 10^(L-1)"],
    [`15${"1".repeat(MAX_KEY_LENGTH)}`, "longer than the cap"],
  ])("%s is not a key (%s)", (key) => {
    expect(isKey(key)).toBe(false);
  });

  test("integer parts order as their values, across signs and lengths", () => {
    // -100, -99, -10, -9, -1, 0, 9, 10, 99, 100 through their encodings.
    const keys = [
      "06900",
      "0701",
      "0790",
      "081",
      "089",
      "10",
      "19",
      "210",
      "299",
      "3100",
    ];
    expect(keys.every(isKey)).toBe(true);
    expect(ascending(keys)).toBe(true);
  });
});

describe("ordering keys: placement", () => {
  test("the first key of an empty list is integer 0 with a random fraction", () => {
    const keys = new Set(
      Array.from({ length: 50 }, () => keyBetween(null, null))
    );
    for (const key of keys) {
      expect(isKey(key)).toBe(true);
      expect(key.startsWith("10")).toBe(true);
    }
    expect(keys.size).toBeGreaterThan(45);
  });

  test("appends increment the integer part and stay short", () => {
    let last: string | null = null;
    const keys: string[] = [];
    for (let index = 0; index < 2000; index += 1) {
      last = keyBetween(last, null);
      keys.push(last);
    }
    expect(ascending(keys)).toBe(true);
    expect(keys.every(isKey)).toBe(true);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(11);
  });

  test("an append after a list of prepends starts at integer 0, as SQL does", () => {
    expect(keyBetween("081", null).startsWith("10")).toBe(true);
  });

  test("prepends decrement the integer part and stay short", () => {
    let first: string | null = null;
    const keys: string[] = [];
    for (let index = 0; index < 2000; index += 1) {
      first = keyBetween(null, first);
      keys.unshift(first);
    }
    expect(ascending(keys)).toBe(true);
    expect(keys.every(isKey)).toBe(true);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(12);
  });

  test("random placements keep a strict order and a valid grammar", () => {
    const list: string[] = [];
    for (let index = 0; index < 3000; index += 1) {
      const at = Math.floor(Math.random() * (list.length + 1));
      const key = keyBetween(list[at - 1] ?? null, list[at] ?? null);
      expect(isKey(key)).toBe(true);
      list.splice(at, 0, key);
    }
    expect(ascending(list)).toBe(true);
  });

  test("repeated inserts into one gap grow keys by about half a digit each", () => {
    let low = keyBetween(null, null);
    const high = keyBetween(low, null);
    let lengths = 0;
    for (let index = 0; index < 100; index += 1) {
      const key = keyBetween(low, high);
      expect(low < key && key < high).toBe(true);
      low = key;
      lengths = key.length;
    }
    // 100 inserts at "just after low": well under one digit each.
    expect(lengths).toBeLessThan(70);
  });

  test("n keys in one gap are evenly spread, ordered and inside it", () => {
    const keys = keysBetween("15", "155", 500);
    expect(keys).toHaveLength(500);
    expect(ascending(["15", ...keys, "155"])).toBe(true);
    expect(keys.every(isKey)).toBe(true);
    expect(Math.max(...keys.map((key) => key.length))).toBeLessThanOrEqual(14);
  });

  test("n keys between distant integers use the free integers", () => {
    const keys = keysBetween("10", "3100", 5);
    expect(ascending(["10", ...keys, "3100"])).toBe(true);
    expect(keys.map((key) => key.slice(0, 2))).toEqual([
      "11",
      "12",
      "13",
      "14",
      "15",
    ]);
  });

  test("n keys between adjacent integers fall under the lower one", () => {
    const keys = keysBetween("15", "16", 3);
    expect(ascending(["15", ...keys, "16"])).toBe(true);
    expect(keys.every((key) => key.startsWith("15"))).toBe(true);
  });

  test("concurrent placements into one gap almost never tie", () => {
    const keys = new Set(
      Array.from({ length: 2000 }, () => keyBetween("15", "16"))
    );
    expect(keys.size).toBeGreaterThanOrEqual(1995);
  });

  test("a gap that is not one is refused", () => {
    expect(() => keyBetween("16", "15")).toThrow(RangeError);
    expect(() => keyBetween("15", "15")).toThrow(RangeError);
    expect(() => keysBetween("15", "16", 0)).toThrow(RangeError);
    expect(() => keyBetween("1a", null)).toThrow(RangeError);
  });
});

describe("ordering keys: collations", () => {
  test("keys compare under every ICU locale as they compare as bytes", () => {
    const locales = Intl.Collator.supportedLocalesOf([
      "cs",
      "sk",
      "da",
      "nb",
      "nn",
      "hu",
      "hr",
      "lt",
      "lv",
      "et",
      "cy",
      "sq",
      "az",
      "uz",
      "ha",
      "yo",
      "es-u-co-trad",
      "de-u-co-phonebk",
      "en",
      "fr",
      "tr",
      "ja",
      "zh",
    ]);
    const list: string[] = [];
    for (let index = 0; index < 300; index += 1) {
      const at = Math.floor(Math.random() * (list.length + 1));
      list.splice(at, 0, keyBetween(list[at - 1] ?? null, list[at] ?? null));
    }
    for (const locale of locales) {
      for (const sensitivity of ["base", "variant"] as const) {
        const collator = new Intl.Collator(locale, { sensitivity });
        const sorted = [...list].sort(collator.compare);
        expect(sorted, `${locale} ${sensitivity}`).toEqual(list);
      }
    }
  });
});
