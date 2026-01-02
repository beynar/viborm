import { describe, test, expect, expectTypeOf } from "vitest";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { v, pipe, transformAction, string, number } from "@validation";

describe("pipe schema", () => {
  describe("basic validation", () => {
    const schema = pipe(
      string(),
      transformAction((s) => s.trim()),
      transformAction((s) => s.toUpperCase())
    );

    test("applies transforms in order", () => {
      const result = schema["~standard"].validate("  hello  ");
      expect(result.issues).toBeUndefined();
      expect((result as { value: string }).value).toBe("HELLO");
    });

    test("validates base first", () => {
      const result = schema["~standard"].validate(123);
      expect(result.issues).toBeDefined();
    });

    test("type inference", () => {
      type Output = StandardSchemaV1.InferOutput<typeof schema>;
      expectTypeOf<Output>().toEqualTypeOf<string>();
    });
  });

  describe("single transform", () => {
    const schema = pipe(string(), transformAction((s) => s.toUpperCase()));

    test("applies single transform", () => {
      const result = schema["~standard"].validate("hello");
      expect((result as { value: string }).value).toBe("HELLO");
    });
  });

  describe("multiple transforms", () => {
    const schema = pipe(
      string(),
      transformAction((s) => s.trim()),
      transformAction((s) => s.toLowerCase()),
      transformAction((s) => s.replace(/\s+/g, "-"))
    );

    test("applies all transforms in sequence", () => {
      const result = schema["~standard"].validate("  HELLO WORLD  ");
      expect((result as { value: string }).value).toBe("hello-world");
    });
  });

  describe("with number transforms", () => {
    const schema = pipe(
      number(),
      transformAction((n) => n * 2),
      transformAction((n) => n + 1)
    );

    test("applies numeric transforms", () => {
      const result = schema["~standard"].validate(10);
      expect((result as { value: number }).value).toBe(21); // (10 * 2) + 1
    });
  });

  describe("transform errors", () => {
    test("handles transform exceptions", () => {
      const schema = pipe(
        string(),
        transformAction(() => {
          throw new Error("Transform failed");
        })
      );
      const result = schema["~standard"].validate("hello");
      expect(result.issues).toBeDefined();
      expect(result.issues![0].message).toContain("Transform failed");
    });
  });

  describe("no transforms", () => {
    const schema = pipe(string());

    test("passes through value without transforms", () => {
      const result = schema["~standard"].validate("hello");
      expect((result as { value: string }).value).toBe("hello");
    });
  });
});

