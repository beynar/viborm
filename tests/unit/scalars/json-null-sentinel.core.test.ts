import {
  AnyNull,
  DbNull,
  isJsonNullSentinel,
  JSON_NULL_BRAND,
  JsonNull,
  JsonNullSentinel,
  jsonNullKindOf,
} from "@schema/json-null";
import { describe, expect, test } from "vitest";

describe("JSON null sentinel identity", () => {
  test("publishes immutable, readable, and serializable sentinel values", () => {
    for (const token of [DbNull, JsonNull, AnyNull]) {
      expect(Object.isFrozen(token)).toBe(true);
      expect(isJsonNullSentinel(token)).toBe(true);
      expect(jsonNullKindOf(token)).toBe(token.kind);
      expect(String(token)).toBe(token.kind);
      expect(JSON.stringify(token)).toBe(
        JSON.stringify(`viborm.json-null:${token.kind}`)
      );
    }
  });

  test("recognizes the shared brand across module instances", () => {
    const foreign = new JsonNullSentinel("DbNull");

    expect(isJsonNullSentinel(foreign)).toBe(true);
    expect(isJsonNullSentinel({ [JSON_NULL_BRAND]: "DbNull" })).toBe(true);
  });

  test("does not mistake ordinary values for sentinels", () => {
    for (const value of [
      null,
      undefined,
      "DbNull",
      {},
      { kind: "DbNull" },
      { [JSON_NULL_BRAND]: "Nope" },
      [],
    ]) {
      expect(isJsonNullSentinel(value)).toBe(false);
      expect(jsonNullKindOf(value)).toBeUndefined();
    }
  });
});
