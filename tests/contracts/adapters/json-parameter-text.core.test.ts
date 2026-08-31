import { JsonParameter } from "@src/sql/json-parameter";
import { describe, expect, test } from "vitest";

/**
 * `JsonParameter` is the distinction a PostgreSQL transport needs when it can
 * only reach a bound value through string coercion or through JSON
 * serialization. Both protocols have to answer the SAME canonical text, which
 * is what these tests pin.
 */
describe("a JSON parameter renders one canonical document", () => {
  test.each([
    ["an array", [1, 2, 3], "[1,2,3]"],
    ["an object", { b: 1, a: 2 }, '{"b":1,"a":2}'],
    ["a string", "hello", '"hello"'],
    ["a number", 42, "42"],
    ["a boolean", true, "true"],
    ["null", null, "null"],
    ["a nested document", { a: [{ b: null }] }, '{"a":[{"b":null}]}'],
  ])("%s coerces and serializes to the same text", (_label, value, text) => {
    const carrier = JsonParameter.from(value);
    if (!carrier) throw new Error("expected a carrier");

    // String coercion — the path a transport takes when it treats the bound
    // value as text.
    expect(String(carrier)).toBe(text);
    expect(carrier.json).toBe(text);

    // JSON serialization — the path Bun SQL takes for a json/jsonb column.
    // Re-serializing the carrier's own output must reproduce those exact bytes.
    expect(JSON.stringify(carrier)).toBe(text);
    expect(carrier.toJSON()).toEqual(value);
  });

  test("the captured text survives a later mutation of the bound value", () => {
    const value = { items: [1] };
    const carrier = JsonParameter.from(value);
    if (!carrier) throw new Error("expected a carrier");

    value.items.push(2);

    expect(carrier.json).toBe('{"items":[1]}');
    expect(JSON.stringify(carrier)).toBe('{"items":[1]}');
  });

  test.each([
    ["undefined", undefined],
    ["a function", () => "unrepresentable"],
    ["a symbol", Symbol("unrepresentable")],
  ])("%s has no JSON text and so has no carrier", (_label, value) => {
    // These bound `undefined` directly before the carrier existed, which
    // providers send as SQL NULL. Carrying them would bind the text
    // "undefined" instead.
    expect(JsonParameter.from(value)).toBeUndefined();
  });

  test("the document is an own property a parameter snapshot can disclose", () => {
    const carrier = JsonParameter.from({ a: 1 });
    if (!carrier) throw new Error("expected a carrier");

    expect(Object.hasOwn(carrier, "json")).toBe(true);
    expect(Object.isFrozen(carrier)).toBe(true);
  });
});
