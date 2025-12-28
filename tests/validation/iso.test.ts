import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, isoTimestamp, isoDate, isoTime } from "../../src/validation";

describe("isoTimestamp schema", () => {
  describe("basic validation", () => {
    const schema = isoTimestamp();

    test("validates ISO timestamps", () => {
      const valid = "2023-12-15T10:30:00.000Z";
      const result = schema["~standard"].validate(valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("validates timestamps with timezone offset", () => {
      const valid = "2023-12-15T10:30:00.000+05:00";
      const result = schema["~standard"].validate(valid);
      expect(result.issues).toBeUndefined();
    });

    test("rejects invalid formats", () => {
      expect(schema["~standard"].validate("2023-12-15").issues).toBeDefined();
      expect(schema["~standard"].validate("not-a-date").issues).toBeDefined();
      expect(
        schema["~standard"].validate("2023-12-15T10:30:00").issues
      ).toBeDefined();
    });

    test("rejects invalid dates", () => {
      expect(
        schema["~standard"].validate("2023-13-15T10:30:00.000Z").issues
      ).toBeDefined();
      expect(
        schema["~standard"].validate("2023-12-32T10:30:00.000Z").issues
      ).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = isoTimestamp({ optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = isoTimestamp({ nullable: true });
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = isoTimestamp({ array: true });
      const result = schema["~standard"].validate(["2023-12-15T10:30:00.000Z"]);
      expect(result.issues).toBeUndefined();
    });
  });
});

describe("isoDate schema", () => {
  describe("basic validation", () => {
    const schema = isoDate();

    test("validates ISO dates", () => {
      const valid = "2023-12-15";
      const result = schema["~standard"].validate(valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("rejects invalid formats", () => {
      expect(
        schema["~standard"].validate("2023-12-15T10:30:00Z").issues
      ).toBeDefined();
      expect(schema["~standard"].validate("12/15/2023").issues).toBeDefined();
      expect(schema["~standard"].validate("2023-1-1").issues).toBeDefined();
    });

    test("rejects invalid dates", () => {
      expect(schema["~standard"].validate("2023-13-15").issues).toBeDefined();
      expect(schema["~standard"].validate("2023-12-32").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = isoDate({ optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = isoDate({ nullable: true });
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = isoDate({ array: true });
      const result = schema["~standard"].validate(["2023-12-15"]);
      expect(result.issues).toBeUndefined();
    });
  });
});

describe("isoTime schema", () => {
  describe("basic validation", () => {
    const schema = isoTime();

    test("validates ISO times", () => {
      const valid = "10:30:00";
      const result = schema["~standard"].validate(valid);
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe(valid);
    });

    test("validates times with milliseconds", () => {
      const valid = "10:30:00.123";
      const result = schema["~standard"].validate(valid);
      expect(result.issues).toBeUndefined();
    });

    test("rejects invalid formats", () => {
      expect(schema["~standard"].validate("10:30").issues).toBeDefined();
      expect(schema["~standard"].validate("10:30:00:00").issues).toBeDefined();
    });

    test("rejects invalid times", () => {
      expect(schema["~standard"].validate("25:00:00").issues).toBeDefined();
      expect(schema["~standard"].validate("10:60:00").issues).toBeDefined();
      expect(schema["~standard"].validate("10:30:60").issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("options", () => {
    test("optional", () => {
      const schema = isoTime({ optional: true });
      expect(schema["~standard"].validate(undefined).issues).toBeUndefined();
    });

    test("nullable", () => {
      const schema = isoTime({ nullable: true });
      expect(schema["~standard"].validate(null).issues).toBeUndefined();
    });

    test("array", () => {
      const schema = isoTime({ array: true });
      const result = schema["~standard"].validate(["10:30:00"]);
      expect(result.issues).toBeUndefined();
    });
  });
});
