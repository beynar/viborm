import type { StandardSchemaV1 } from "@standard-schema/spec";
import { date } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("date schema", () => {
  describe("basic validation", () => {
    const schema = date();

    test("validates Date objects", () => {
      const d = new Date();
      const result = schema["~standard"].validate(d);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date }).value).toEqual(d);
    });

    test("validates valid date strings", () => {
      const d = new Date("2023-01-01");
      const result = schema["~standard"].validate(d);
      expect(result.issues).toBeUndefined();
    });

    test("rejects invalid dates", () => {
      const result = schema["~standard"].validate(new Date("invalid"));
      expect(result.issues).toBeDefined();
    });

    test("rejects non-dates", () => {
      expect(schema["~standard"].validate("2023-01-01").issues).toBeDefined();
      expect(schema["~standard"].validate(123_456_789).issues).toBeDefined();
      expect(schema["~standard"].validate(null).issues).toBeDefined();
      expect(schema["~standard"].validate(undefined).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<Date>();
      expectTypeOf<Input>().toEqualTypeOf<Date>();
    });
  });

  describe("optional option", () => {
    const schema = date({ optional: true });

    test("allows undefined", () => {
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });

    test("validates dates", () => {
      const result = schema["~standard"].validate(new Date());
      expect(result.issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<Date | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = date({ nullable: true });

    test("allows null", () => {
      const result = schema["~standard"].validate(null);
      expect(result.issues).toBeUndefined();
    });

    test("validates dates", () => {
      const result = schema["~standard"].validate(new Date());
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = date({ array: true });

    test("validates array of dates", () => {
      const dates = [new Date("2023-01-01"), new Date("2023-01-02")];
      const result = schema["~standard"].validate(dates);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date[] }).value).toEqual(dates);
    });

    test("rejects array with invalid dates", () => {
      const result = schema["~standard"].validate([
        new Date(),
        new Date("invalid"),
      ]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const defaultDate = new Date("2023-01-01");
      const schema = date({ default: defaultDate });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date }).value).toEqual(defaultDate);
    });

    test("default factory function", () => {
      const schema = date({ default: () => new Date("2023-01-01") });
      const result = schema["~standard"].validate(undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("transform option", () => {
    const schema = date({ transform: (d) => d.toISOString() } as any);

    test("applies transform to output", () => {
      const d = new Date("2023-01-01");
      const result = schema["~standard"].validate(d);
      expect((result as { value: unknown }).value).toBe(d.toISOString());
    });
  });
});
