// Test for simplified field validation system
// Verifies that fields only accept a single standard schema validator

import z from "zod";
import {
  string,
  int,
  boolean,
  datetime,
  blob,
  bigint,
  enumField,
} from "../src/schema/fields/index.js";

describe("Simplified Field Validation", () => {
  describe("single validator per field", () => {
    test("string field accepts only one standard schema validator", async () => {
      const field = string().validator(z.string().min(3));

      // Test successful validation
      const validResult = await field["~validate"]("hello");
      expect(validResult.valid).toBe(true);
      expect(validResult.errors).toBeUndefined();

      // Test failed validation
      const invalidResult = await field["~validate"]("hi");
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("number field accepts only one standard schema validator", async () => {
      const field = int().validator(z.number().min(0));

      const validResult = await field["~validate"](5);
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"](-1);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("boolean field accepts only one standard schema validator", async () => {
      const field = boolean().validator(z.literal(true));

      const validResult = await field["~validate"](true);
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"](false);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("datetime field accepts only one standard schema validator", async () => {
      const field = datetime().validator(z.date().min(new Date("2020-01-01")));

      const validResult = await field["~validate"](new Date("2023-01-01"));
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"](new Date("2019-01-01"));
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("bigint field accepts only one standard schema validator", async () => {
      const field = bigint().validator(z.bigint().min(0n));

      const validResult = await field["~validate"](5n);
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"](-1n);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("enum field accepts only one standard schema validator", async () => {
      const field = enumField(["red", "green", "blue"] as const).validator(
        z.enum(["red", "green", "blue"])
      );

      const validResult = await field["~validate"]("green");
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"]("purple");
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("blob field accepts only one standard schema validator", async () => {
      const field = blob().validator(z.instanceof(Uint8Array));

      const validResult = await field["~validate"](new Uint8Array([1, 2, 3]));
      expect(validResult.valid).toBe(true);

      const invalidResult = await field["~validate"]([]);
      expect(invalidResult.valid).toBe(false);
    });
  });

  describe("validator method chaining", () => {
    test("validator method returns the same field instance for chaining", () => {
      const field = string();
      const chainedField = field.validator(z.string().min(3));

      // Should return the same instance for chaining
      expect(chainedField).toBe(field);
    });

    test("validator method can be chained with other field methods", () => {
      const field = string().validator(z.string().min(3)).nullable().unique();

      expect(field["~isOptional"]).toBe(true);
      expect(field["~isUnique"]).toBe(true);
    });
  });

  describe("validator is preserved across field operations", () => {
    test("validator is preserved when creating nullable field", async () => {
      const field = string().validator(z.string().min(3)).nullable();

      // Test that validator still works
      const invalidResult = await field["~validate"]("hi");
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });

    test("validator is preserved when setting default value", async () => {
      const field = int().validator(z.number().min(0)).default(10);

      // Test that validator still works
      const invalidResult = await field["~validate"](-5);
      expect(invalidResult.valid).toBe(false);
      expect(invalidResult.errors.length).toBe(1);
    });
  });
});
