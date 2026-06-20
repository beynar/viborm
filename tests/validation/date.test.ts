import type { StandardSchemaV1 } from "@standard-schema/spec";
import v, { parse } from "@validation";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("date schema", () => {
  describe("basic validation", () => {
    const schema = v.date();

    test("validates Date objects", () => {
      const d = new Date();
      const result = parse(schema, d);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date }).value).toEqual(d);
    });

    test("validates valid date strings", () => {
      const d = new Date("2023-01-01");
      const result = parse(schema, d);
      expect(result.issues).toBeUndefined();
    });

    test("rejects invalid dates", () => {
      const result = parse(schema, new Date("invalid"));
      expect(result.issues).toBeDefined();
    });

    test("rejects non-dates", () => {
      expect(parse(schema, "2023-01-01").issues).toBeDefined();
      expect(parse(schema, 123_456_789).issues).toBeDefined();
      expect(parse(schema, null).issues).toBeDefined();
      expect(parse(schema, undefined).issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      type Input = StandardSchemaV1.InferInput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<Date>();
      expectTypeOf<Input>().toMatchTypeOf<Date>();
    });
  });

  describe("optional option", () => {
    const schema = v.date({ optional: true });

    test("allows undefined", () => {
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });

    test("validates dates", () => {
      const result = parse(schema, new Date());
      expect(result.issues).toBeUndefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toMatchTypeOf<Date | undefined>();
    });
  });

  describe("nullable option", () => {
    const schema = v.date({ nullable: true });

    test("allows null", () => {
      const result = parse(schema, null);
      expect(result.issues).toBeUndefined();
    });

    test("validates dates", () => {
      const result = parse(schema, new Date());
      expect(result.issues).toBeUndefined();
    });
  });

  describe("array option", () => {
    const schema = v.date({ array: true });

    test("validates array of dates", () => {
      const dates = [new Date("2023-01-01"), new Date("2023-01-02")];
      const result = parse(schema, dates);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date[] }).value).toEqual(dates);
    });

    test("rejects array with invalid dates", () => {
      const result = parse(schema, [
        new Date(),
        new Date("invalid"),
      ]);
      expect(result.issues).toBeDefined();
    });
  });

  describe("default option", () => {
    test("static default", () => {
      const defaultDate = new Date("2023-01-01");
      const schema = v.date({ default: defaultDate });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
      expect((result as { value: Date }).value).toEqual(defaultDate);
    });

    test("default factory function", () => {
      const schema = v.date({ default: () => new Date("2023-01-01") });
      const result = parse(schema, undefined);
      expect(result.issues).toBeUndefined();
    });
  });

  describe("transform option", () => {
    const schema = v.date({ transform: (d) => d.toISOString() } as any);

    test("applies transform to output", () => {
      const d = new Date("2023-01-01");
      const result = parse(schema, d);
      expect((result as { value: unknown }).value).toBe(d.toISOString());
    });
  });
});
