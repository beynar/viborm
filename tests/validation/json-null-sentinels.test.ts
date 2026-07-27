import { generateCacheKey } from "@cache/key";
import {
  AnyNull,
  DbNull,
  isJsonNullSentinel,
  JSON_NULL_BRAND,
  JsonNull,
  JsonNullSentinel,
  jsonNullKindOf,
} from "@schema/json-null";
import { json } from "@schema/scalars/json/scalar";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, test } from "vitest";

/**
 * The sentinels as VALUES: what they are, what recognizes them, and the two
 * places a plain-object token would have gone wrong.
 *
 * Dialect SQL lives in `tests/query-engine/json-null-sentinel-sql.test.ts`;
 * execution in `tests/drivers/json-null-sentinel-behavior.ts`.
 */
describe("JSON null sentinels", () => {
  const nullable = getScalarSchemas(json().nullable()["~"].state);
  const required = getScalarSchemas(json()["~"].state);

  describe("the tokens", () => {
    test("each is frozen, named, and recognized", () => {
      for (const token of [DbNull, JsonNull, AnyNull]) {
        expect(Object.isFrozen(token)).toBe(true);
        expect(isJsonNullSentinel(token)).toBe(true);
        expect(jsonNullKindOf(token)).toBe(token.kind);
        expect(String(token)).toBe(token.kind);
      }
      expect(DbNull.kind).toBe("DbNull");
      expect(JsonNull.kind).toBe("JsonNull");
      expect(AnyNull.kind).toBe("AnyNull");
    });

    test("the brand check is a property probe, not instanceof", () => {
      // A token from a duplicated copy of the module must still be recognized,
      // which is why `Symbol.for` and a probe are used rather than `instanceof`
      const foreign = new JsonNullSentinel("DbNull");
      expect(isJsonNullSentinel(foreign)).toBe(true);
      expect(isJsonNullSentinel({ [JSON_NULL_BRAND]: "DbNull" })).toBe(true);
    });

    test("nothing else is a sentinel", () => {
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

    /**
     * The reason `kind` is an own ENUMERABLE string key and not only the symbol
     * brand: the cache key builder walks `Object.keys`, so three symbol-only
     * tokens would all serialize to `{}` and two different questions would
     * share one cache entry.
     */
    test("the three hash to different cache keys", () => {
      const keyFor = (value: unknown) =>
        generateCacheKey("entry", "findMany", {
          where: { meta: { equals: value } },
        });
      const keys = [keyFor(DbNull), keyFor(JsonNull), keyFor(AnyNull)];
      expect(new Set(keys).size).toBe(3);
      expect(keys).not.toContain(keyFor(null));
    });
  });

  describe("write slots", () => {
    test("a nullable JSON field takes DbNull and JsonNull", () => {
      for (const token of [DbNull, JsonNull]) {
        const created = parse(nullable.create, token);
        if (created.issues) throw new Error(`create refused ${token.kind}`);
        expect(created.value).toBe(token);

        const updated = parse(nullable.update, token);
        if (updated.issues) throw new Error(`update refused ${token.kind}`);
        expect(updated.value).toEqual({ set: token });
      }
    });

    test("AnyNull is refused by name in write position", () => {
      const created = parse(nullable.create, AnyNull);
      expect(created.issues?.[0]?.message).toBe(
        "AnyNull is not supported in JSON write data; that slot accepts DbNull or JsonNull."
      );
    });

    test("DbNull is refused on a non-nullable JSON field", () => {
      const created = parse(required.create, DbNull);
      expect(created.issues?.[0]?.message).toBe(
        "DbNull is not supported in JSON write data; that slot accepts JsonNull."
      );
      const jsonNull = parse(required.create, JsonNull);
      expect(jsonNull.issues).toBeUndefined();
    });

    test("a bare top-level null is refused, and says which token to use", () => {
      const message = parse(nullable.create, null).issues?.[0]?.message ?? "";
      expect(message).toContain("null is ambiguous");
      expect(message).toContain("DbNull");
      expect(message).toContain("JsonNull");

      const nonNullable =
        parse(required.create, null).issues?.[0]?.message ?? "";
      expect(nonNullable).toContain("not nullable");
    });

    /**
     * The hazard the class-instance token exists to close: `v.json` accepts an
     * arbitrary object, so a plain-object sentinel nested inside a document
     * would have validated and been PERSISTED as `{}` — silently corrupting the
     * user's data. A class instance fails the plain-object check instead.
     */
    test("a sentinel nested inside a document is refused", () => {
      for (const payload of [
        { inner: DbNull },
        [JsonNull],
        { deep: { deeper: [AnyNull] } },
      ]) {
        expect(parse(nullable.create, payload).issues).toBeDefined();
        expect(parse(nullable.update, payload).issues).toBeDefined();
      }
    });

    test("nested nulls are untouched — only the top level is refused", () => {
      const document = { a: null, b: [null], c: { d: null } };
      const created = parse(nullable.create, document);
      if (created.issues) throw new Error("Expected success");
      expect(created.value).toEqual(document);
    });
  });

  describe("filter slots", () => {
    test("all three sentinels are accepted on equals and not", () => {
      for (const token of [DbNull, JsonNull, AnyNull]) {
        expect(
          parse(nullable.filter, { equals: token }).issues
        ).toBeUndefined();
        expect(parse(nullable.filter, { not: token }).issues).toBeUndefined();
      }
    });

    test("a sentinel is not an operand of the value operators", () => {
      expect(
        parse(nullable.filter, { array_contains: DbNull }).issues
      ).toBeDefined();
      expect(
        parse(nullable.filter, { string_contains: JsonNull }).issues
      ).toBeDefined();
      expect(parse(nullable.filter, { gt: AnyNull }).issues).toBeDefined();
    });

    // Pinned regression witness: bare null in FILTER position is unchanged
    test("a bare null is still a legal filter operand", () => {
      const result = parse(nullable.filter, { equals: null });
      if (result.issues) throw new Error("Expected success");
      expect(result.value).toEqual({ equals: null });
    });
  });
});
