import { ValidationError, VibORMErrorCode } from "@errors";
import v, { parse } from "@validation";
import type { InferOutput, VibSchema } from "@validation/types";
import { describe, expect, expectTypeOf, test } from "vitest";

describe("fromObject", () => {
  test("extracts schemas at a simple path and validates", () => {
    const object = {
      key1: { create: v.string() },
      key2: { create: v.number() },
    };

    const schema = v.fromObject(object, "create");

    // Check schema structure
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.entries)).toEqual(["key1", "key2"]);
    expect(schema.entries.key1.type).toBe("string");
    expect(schema.entries.key2.type).toBe("number");

    // Test validation
    const validResult = parse(schema, { key1: "hello", key2: 42 });
    expect(validResult.issues).toBeUndefined();
    expect((validResult as any).value).toEqual({ key1: "hello", key2: 42 });

    // Test invalid input
    const invalidResult = parse(schema, { key1: 123, key2: 42 });
    expect(invalidResult.issues).toBeDefined();
  });

  test("builds an empty schema from an empty source object", () => {
    const schema = v.fromObject({}, "create");

    expect(schema.type).toBe("object");
    expect(schema.entries).toEqual({});

    const result = parse(schema, {});
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toEqual({});
  });

  test("throws when a path matches no entries in a non-empty source object", () => {
    const object = {
      key1: { update: v.string() },
      key2: { update: v.number() },
    };

    expect(() => v.fromObject(object, "create")).toThrow(
      'fromObject path "create" did not match any entries in the source object'
    );

    try {
      v.fromObject(object, "create");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      if (!(error instanceof ValidationError)) return;
      expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
      expect(error.source).toEqual({
        kind: "schema-builder",
        builder: "fromObject",
        path: "create",
      });
    }
  });

  test("reports a path that stops at a null intermediate value", () => {
    expect(() =>
      v.fromObject({ user: { nested: null } }, "nested.value")
    ).toThrowError(ValidationError);
  });

  test("does not throw when only some entries miss the path", () => {
    const object = {
      key1: { create: v.string() },
      key2: { update: v.number() },
    };

    const schema = v.fromObject(object, "create");

    expect(Object.keys(schema.entries)).toEqual(["key1"]);
    const result = parse(schema, { key1: "hello" });
    expect(result.issues).toBeUndefined();
  });

  test("extracts schemas at a nested path (2 levels)", () => {
    const nestedObject = {
      user: { profile: { settings: v.boolean() } },
      post: { profile: { settings: v.string() } },
    };

    const schema = v.fromObject(nestedObject, "profile.settings");

    // Check schema structure
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.entries)).toEqual(["user", "post"]);
    expect(schema.entries.user.type).toBe("boolean");
    expect(schema.entries.post.type).toBe("string");

    // Test validation
    const validResult = parse(schema, { user: true, post: "active" });
    expect(validResult.issues).toBeUndefined();
  });

  test("throws when a nested path matches no entries in a non-empty source object", () => {
    const object = {
      user: { profile: { update: v.string() } },
      post: { profile: { update: v.number() } },
    };

    expect(() => v.fromObject(object, "profile.create")).toThrow(
      'fromObject path "profile.create" did not match any entries in the source object'
    );
  });

  test("extracts schemas at deeply nested path (3 levels)", () => {
    const deepObject = {
      user: { level1: { level2: { level3: v.string() } } },
      post: { level1: { level2: { level3: v.number() } } },
      comment: { level1: { level2: { level3: v.boolean() } } },
    };

    const schema = v.fromObject(deepObject, "level1.level2.level3");

    expect(schema.type).toBe("object");
    expect(Object.keys(schema.entries)).toEqual(["user", "post", "comment"]);
    expect(schema.entries.user.type).toBe("string");
    expect(schema.entries.post.type).toBe("number");
    expect(schema.entries.comment.type).toBe("boolean");

    // Test validation
    const validResult = parse(schema, {
      user: "hello",
      post: 42,
      comment: true,
    });
    expect(validResult.issues).toBeUndefined();
    expect((validResult as any).value).toEqual({
      user: "hello",
      post: 42,
      comment: true,
    });
  });

  test("extracts schemas at deeply nested path (4 levels)", () => {
    const veryDeepObject = {
      a: { b: { c: { d: { e: v.string() } } } },
      x: { b: { c: { d: { e: v.number() } } } },
    };

    const schema = v.fromObject(veryDeepObject, "b.c.d.e");

    expect(schema.type).toBe("object");
    expect(schema.entries.a.type).toBe("string");
    expect(schema.entries.x.type).toBe("number");

    const validResult = parse(schema, { a: "test", x: 123 });
    expect(validResult.issues).toBeUndefined();
  });

  test("works with recursive thunks (circular references)", () => {
    // Define a recursive schema using thunks
    const nodeSchema: VibSchema<any, any> = v.object({
      value: v.string(),
      child: () => nodeSchema, // Thunk for circular reference
    });

    const models = {
      tree: { schema: nodeSchema },
      forest: { schema: v.object({ name: v.string() }) },
    };

    const schema = v.fromObject(models, "schema");

    // Type should properly infer both tree and forest schemas
    type O = InferOutput<typeof schema>;
    expectTypeOf<O>().toExtend<{
      tree?: any;
      forest?: { name?: string };
    }>();

    expect(schema.type).toBe("object");
    expect(schema.entries.tree.type).toBe("object");
    expect(schema.entries.forest.type).toBe("object");

    // Validate a tree structure
    const validResult = parse(schema, {
      tree: { value: "root", child: { value: "leaf" } },
      forest: { name: "amazon" },
    });
    expect(validResult.issues).toBeUndefined();
  });

  test("works with deeply nested thunks", () => {
    // A more complex recursive structure
    type Node = { id: string; children?: Node[] };

    const nodeSchema = v.object({
      id: v.string(),
      children: () => v.object({ items: nodeSchema }, { array: true }),
    });

    const models = {
      graph: { nodes: { root: nodeSchema } },
      list: { nodes: { root: v.string() } },
    };

    const schema = v.fromObject(models, "nodes.root");

    expect(schema.type).toBe("object");
    expect(schema.entries.graph.type).toBe("object");
    expect(schema.entries.list.type).toBe("string");
  });

  test("supports partial option (default: true)", () => {
    const object = {
      key1: { create: v.string() },
      key2: { create: v.number() },
    };

    const schema = v.fromObject(object, "create");

    // Partial by default - missing keys are allowed
    const result = parse(schema, { key1: "hello" });
    expect(result.issues).toBeUndefined();
  });

  test("supports partial: false option", () => {
    const object = {
      key1: { create: v.string() },
      key2: { create: v.number() },
    };

    const schema = v.fromObject(object, "create", { partial: false });

    // Non-partial - missing keys are errors
    const result = parse(schema, { key1: "hello" });
    expect(result.issues).toBeDefined();
    expect(result.issues?.[0]?.message).toContain("Missing required field");
  });

  test("supports optional option", () => {
    const object = {
      key1: { create: v.string() },
    };

    const schema = v.fromObject(object, "create", { optional: true });

    // Undefined is allowed
    const result = parse(schema, undefined);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toBeUndefined();
  });

  test("supports nullable option", () => {
    const object = {
      key1: { create: v.string() },
    };

    const schema = v.fromObject(object, "create", { nullable: true });

    // Null is allowed
    const result = parse(schema, null);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toBeNull();
  });

  test("supports array option", () => {
    const object = {
      key1: { create: v.string() },
      key2: { create: v.number() },
    };

    const schema = v.fromObject(object, "create", { array: true });

    // Array of objects
    const result = parse(schema, [
      { key1: "a", key2: 1 },
      { key1: "b", key2: 2 },
    ]);
    expect(result.issues).toBeUndefined();
    expect((result as any).value).toEqual([
      { key1: "a", key2: 1 },
      { key1: "b", key2: 2 },
    ]);
  });

  describe("type inference", () => {
    test("preserves type information per key", () => {
      const object = {
        key1: { create: v.string() },
        key2: { create: v.number() },
      };

      const schema = v.fromObject(object, "create");

      // Type test: schema should have proper entries type
      expectTypeOf(schema.entries.key1).toExtend<{ type: string }>();
      expectTypeOf(schema.entries.key2).toExtend<{ type: string }>();
    });

    test("infers correct output type for simple path", () => {
      const object = {
        name: { create: v.string() },
        age: { create: v.number() },
      };

      const schema = v.fromObject(object, "create", { partial: false });

      // The output type should match the expected shape
      type ExpectedOutput = { name: string; age: number };

      expectTypeOf<InferOutput<typeof schema>>().toExtend<ExpectedOutput>();
    });

    test("infers correct output type for nested path", () => {
      const object = {
        user: { settings: { theme: v.string() } },
        admin: { settings: { theme: v.boolean() } },
      };

      const schema = v.fromObject(object, "settings.theme", { partial: false });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{
        user: string;
        admin: boolean;
      }>();
    });

    test("infers partial type when partial: true (default)", () => {
      const object = {
        a: { s: v.string() },
        b: { s: v.number() },
      };

      const schema = v.fromObject(object, "s");

      // With partial: true (default), all keys are optional
      expectTypeOf<InferOutput<typeof schema>>().toExtend<
        Partial<{ a: string; b: number }>
      >();
    });

    test("infers array type when array: true", () => {
      const object = {
        x: { val: v.string() },
      };

      const schema = v.fromObject(object, "val", {
        array: true,
        partial: false,
      });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{ x: string }[]>();
    });

    test("infers nullable type when nullable: true", () => {
      const object = {
        x: { val: v.string() },
      };

      const schema = v.fromObject(object, "val", {
        nullable: true,
        partial: false,
      });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{
        x: string;
      } | null>();
    });

    test("infers optional type when optional: true", () => {
      const object = {
        x: { val: v.string() },
      };

      const schema = v.fromObject(object, "val", {
        optional: true,
        partial: false,
      });
      type O = InferOutput<typeof schema>;
      expectTypeOf<O>().toExtend<{ x: string } | undefined>();
    });
  });

  describe("deep path type inference", () => {
    test("correctly types 3-level deep paths", () => {
      const object = {
        user: { a: { b: { c: v.string() } } },
        post: { a: { b: { c: v.number() } } },
      };

      const schema = v.fromObject(object, "a.b.c", { partial: false });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{
        user: string;
        post: number;
      }>();
    });

    test("correctly types 4-level deep paths", () => {
      const object = {
        x: { l1: { l2: { l3: { l4: v.boolean() } } } },
        y: { l1: { l2: { l3: { l4: v.string() } } } },
      };

      const schema = v.fromObject(object, "l1.l2.l3.l4", { partial: false });

      expectTypeOf<InferOutput<typeof schema>>().toExtend<{
        x: boolean;
        y: string;
      }>();
    });
  });
});
