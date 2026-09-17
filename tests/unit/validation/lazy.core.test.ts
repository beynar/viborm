import { parse, v } from "@validation";
import { lazyScalarSchemas } from "@validation/lazy";
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
    expect(Reflect.get(schema, "wrapped")).toBe(target);
    expect(parse(schema, { name: "Ada" }).issues).toBeUndefined();
    expect(
      schema["~standard"].jsonSchema.output({ target: "draft-07" })
    ).toMatchObject({ type: "object" });
    expect(resolutions).toBe(1);
  });
});

/**
 * The four variants of ONE scalar field, which `scalars/family.ts` materializes
 * through this helper.
 *
 * What the helper promises is pay-per-use: a `findUnique` that reads only
 * `filter` must not build the create and update trees, each variant must be
 * built at most once, and a variant that has resolved must release the factory
 * that built it while its siblings stay lazy. The last clause is what a thunk
 * that closes over the whole builder record quietly breaks: it keeps every
 * sibling factory reachable from the one variant nobody has read yet.
 */
describe("scalar variant laziness", () => {
  const counted = () => {
    const built: string[] = [];
    const build = (name: string) => () => {
      built.push(name);
      return name;
    };
    const schemas = lazyScalarSchemas<{
      base: string;
      create: string;
      update: string;
      filter: string;
    }>({
      base: "base",
      create: build("create"),
      update: build("update"),
      filter: build("filter"),
    });
    return { built, schemas };
  };

  test("a variant nobody reads is never built", () => {
    const { built, schemas } = counted();
    expect(built).toEqual([]);
    expect(schemas.base).toBe("base");
    expect(built).toEqual([]);
    expect(schemas.filter).toBe("filter");
    expect(built).toEqual(["filter"]);
  });

  test("each variant is built once, however often it is read", () => {
    const { built, schemas } = counted();
    expect(schemas.update).toBe("update");
    expect(schemas.update).toBe("update");
    expect(schemas.filter).toBe("filter");
    expect(schemas.create).toBe("create");
    expect(schemas.create).toBe("create");
    expect(built).toEqual(["update", "filter", "create"]);
  });

  test("the record is indistinguishable from an eager one", () => {
    const { schemas } = counted();
    expect(Object.keys(schemas)).toEqual([
      "base",
      "create",
      "update",
      "filter",
    ]);
    expect("filter" in schemas).toBe(true);
  });
});
