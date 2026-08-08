import { parse, v } from "@validation";
import { describe, expect, test } from "vitest";

describe("lazy schema reflection", () => {
  test("resolves once and forwards reflection to the owned schema", () => {
    let resolutions = 0;
    const target = v.object({ name: v.string() });
    const schema = v.lazy(() => {
      resolutions += 1;
      return target;
    });

    expect("entries" in schema).toBe(true);
    expect(Reflect.ownKeys(schema)).toContain("entries");
    expect(Reflect.getOwnPropertyDescriptor(schema, "type")?.value).toBe(
      "object"
    );
    expect(Reflect.getPrototypeOf(schema)).toBe(Reflect.getPrototypeOf(target));
    expect(schema.extend({ age: v.number() }).entries).toHaveProperty("age");
    expect(parse(schema, { name: "Ada" }).issues).toBeUndefined();
    expect(resolutions).toBe(1);
  });

  test("lazyRef exposes entries, validation, wrapping, and JSON Schema on demand", () => {
    let resolutions = 0;
    const target = v.object({ name: v.string() });
    const schema = v.lazyRef(() => {
      resolutions += 1;
      return target;
    });

    expect(schema.type).toBe("lazyRef");
    expect(schema.entries).toBe(target.entries);
    expect(schema.wrapped).toBe(target);
    expect(parse(schema, { name: "Ada" }).issues).toBeUndefined();
    expect(
      schema["~standard"].jsonSchema.output({ target: "draft-07" })
    ).toMatchObject({ type: "object" });
    expect(resolutions).toBe(1);
  });
});
