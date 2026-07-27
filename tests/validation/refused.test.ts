import { s } from "@schema";
import { getSchemas } from "@schema/schemas";
import v, { parse, toJsonSchema } from "@validation";
import type { JsonSchema } from "@validation/json-schema";
import { describe, expect, test } from "vitest";

/**
 * `v.refused` — a key that EXISTS on an object schema only so the refusal can
 * carry a reason.
 *
 * Omitting the key already rejects it, with `Unknown key: gt`, which reads like
 * a typo and tells the caller nothing. Some keys are missing for a reason worth
 * stating: ordered comparison on an enum has no answer that agrees across
 * providers, so it is refused everywhere rather than answered differently on
 * each — the portability rule in its refusal form.
 */
describe("refused", () => {
  test("rejects every value with the reason it was given", () => {
    const schema = v.refused("because I said so");
    for (const value of [1, "x", null, undefined, {}, []]) {
      expect(parse(schema, value).issues?.[0]?.message).toBe(
        "because I said so"
      );
    }
  });

  test("converts to a JSON Schema that accepts nothing", () => {
    expect(toJsonSchema(v.refused("nope"))).toEqual({
      not: {},
      $schema: "http://json-schema.org/draft-07/schema#",
    });
  });
});

describe("ordered comparison on an enum", () => {
  const model = s.model({
    id: s.string().id(),
    role: s.enum(["admin", "member"]),
    name: s.string(),
  });

  const roleFilter = () => getSchemas({ model }).model.scalars.role.filter;

  test.each([
    "lt",
    "lte",
    "gt",
    "gte",
  ])("%s is refused with the portability reason", (operator) => {
    const result = parse(roleFilter(), { [operator]: "admin" });
    const message = result.issues?.[0]?.message ?? "";

    expect(message).toContain(`Filter operation '${operator}'`);
    expect(message).toContain("PostgreSQL orders enum values");
    // The reason, not just the verdict: a caller has to be able to tell this
    // apart from a typo and know what to reach for instead.
    expect(message).toContain("Use 'equals'/'in'");
  });

  test("equality operators still work", () => {
    for (const filter of [
      { equals: "admin" },
      { not: "admin" },
      { in: ["admin", "member"] },
      { notIn: ["admin"] },
      { not: { not: { equals: "member" } } },
    ]) {
      expect(parse(roleFilter(), filter).issues).toBeUndefined();
    }
  });

  /**
   * The refused keys must not cost the filter its JSON-Schema surface — a
   * schema type the converter has never heard of takes emission down for every
   * payload containing one.
   */
  test("the filter still converts to JSON Schema", () => {
    const document = toJsonSchema(roleFilter()) as JsonSchema;
    const ref = (document.anyOf?.[1] as JsonSchema)?.$ref as string;
    const filterObject = document.$defs?.[ref.slice("#/$defs/".length)];
    expect(filterObject?.properties?.gt).toEqual({ not: {} });
    expect(filterObject?.properties?.equals).toEqual({
      enum: ["admin", "member"],
    });
  });
});
