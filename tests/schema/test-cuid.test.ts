import { describe, test, expect } from "vitest";
import { s } from "../../src/schema/index.js";
import { wrapAutoGenerate } from "../../src/schema/fields/validators/utils.js";
import { string } from "zod/v4-mini";

describe("CUID Auto Generation", () => {
  test("should generate a valid CUID", () => {
    const field = s.string().cuid();

    // Manually create the schema with auto-generation wrapping
    const baseSchema = string();
    const schema = wrapAutoGenerate(baseSchema, field);

    // Test that parsing undefined generates a CUID
    const result = schema.parse(undefined) as string;

    expect(typeof result).toBe("string");
    expect(result).toMatch(/^c[0-9a-z]+$/); // Should start with 'c' and contain base36 chars
    expect(result.length).toBeGreaterThan(10); // Should be reasonably long
  });

  test("should generate different CUIDs on subsequent calls", () => {
    const field = s.string().cuid();

    // Manually create the schema with auto-generation wrapping
    const baseSchema = string();
    const schema = wrapAutoGenerate(baseSchema, field);

    const result1 = schema.parse(undefined) as string;
    const result2 = schema.parse(undefined) as string;

    expect(result1).not.toBe(result2);
  });

  test("should preserve existing values", () => {
    const field = s.string().cuid();

    // Manually create the schema with auto-generation wrapping
    const baseSchema = string();
    const schema = wrapAutoGenerate(baseSchema, field);

    const existingValue = "existing-value";
    const result = schema.parse(existingValue) as string;

    expect(result).toBe(existingValue);
  });
});
