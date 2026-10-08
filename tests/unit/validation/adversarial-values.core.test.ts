import { ValidationError } from "@errors";
import { s } from "@schema";
import { createSchemaRegistry, toJsonSchema } from "@validation";
import v from "@validation/primitives/v";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("canonical temporal and JSON admission", () => {
  it.each([
    "2024-01-15T10:30:00Z",
    "2024-01-15T11:30:00+01:00",
    "2024-01-15T10:30:00.0Z",
  ])("gives equivalent timestamp %s one stored spelling", (input) => {
    expect(v.isoTimestamp()["~standard"].validate(input)).toEqual({
      value: "2024-01-15T10:30:00.000Z",
    });
  });

  it.each([
    ["23:59:59.999", "23:59:59.999"],
    ["12:30:00", "12:30:00.000"],
    ["12:30:00.1", "12:30:00.100"],
  ])("canonicalizes admitted time %s", (input, expected) => {
    expect(v.isoTime()["~standard"].validate(input)).toEqual({
      value: expected,
    });
  });

  it("allows repeated JSON references while refusing cycles", () => {
    const leaf = { value: 1 };
    const document = { first: leaf, second: leaf };
    expect(v.json()["~standard"].validate(document)).toEqual({
      value: document,
    });
    const cyclic: { next?: unknown } = {};
    cyclic.next = cyclic;
    expect(v.json()["~standard"].validate(cyclic)).toHaveProperty("issues");
  });

  it("checks a JSON transform's physical output before writing", () => {
    const schema = v.json({ transform: () => new Date() });
    expect(schema["~standard"].validate({ value: 1 })).toHaveProperty("issues");
  });

  it("normalizes undefined JSON members without mutating caller data", () => {
    const shared = { theme: "dark", nickname: undefined };
    const input = { first: shared, second: shared, values: [undefined, 3] };
    const result = v.json()["~standard"].validate(input);
    expect(result).toEqual({
      value: {
        first: { theme: "dark" },
        second: { theme: "dark" },
        values: [null, 3],
      },
    });
    expect(Object.hasOwn(shared, "nickname")).toBe(true);
    expect(v.json()["~standard"].validate(undefined)).toHaveProperty("issues");
    expect(v.json()["~standard"].validate({ illegal: 1n })).toHaveProperty(
      "issues"
    );
    const field = v.json({
      schema: z.object({ theme: z.string(), nickname: z.string().optional() }),
    });
    expect(field["~standard"].validate(shared)).toEqual({
      value: { theme: "dark" },
    });
  });

  it("applies a typed JSON document schema to writes, not path operands", () => {
    const entry = s.model({
      id: s.string().id(),
      body: s.json().schema(z.object({ title: z.string(), views: z.number() })),
    });
    const registry = createSchemaRegistry({ entry });
    expect(() =>
      registry.validate("entry", "findMany", {
        where: { body: { path: ["title"], equals: "hello" } },
      })
    ).not.toThrow();
    expect(() =>
      registry.validate("entry", "create", {
        data: { id: "one", body: { title: "hello" } },
      })
    ).toThrow(ValidationError);
    expect(
      registry.validate("entry", "update", {
        where: { id: "one" },
        data: { body: { set: { title: "hello", views: 2 } } },
      })
    ).toMatchObject({ data: { body: { set: { title: "hello", views: 2 } } } });
    expect(() =>
      registry.validate("entry", "update", {
        where: { id: "one" },
        data: { body: { set: { title: "hello" } } },
      })
    ).toThrow(ValidationError);
  });

  it("bounds boolean and scalar filter recursion and restores the budget", () => {
    const entry = s.model({ id: s.string().id() });
    const registry = createSchemaRegistry({ entry });
    let where: unknown = { id: "one" };
    let scalar: unknown = { equals: "one" };
    for (let depth = 0; depth < 1000; depth++) {
      where = { AND: where };
      scalar = { not: scalar };
    }
    for (const filter of [where, { id: scalar }]) {
      expect(() =>
        registry.validate("entry", "findMany", { where: filter })
      ).toThrow(ValidationError);
      expect(() =>
        registry.validate("entry", "findMany", { where: filter })
      ).toThrow("Filter nesting exceeds 16 levels");
    }
    expect(() =>
      registry.validate("entry", "findMany", {
        where: { AND: { id: { not: { not: "one" } } } },
      })
    ).not.toThrow();
  });

  it("bounds nested relation filters before SQL planning", () => {
    const node = s.model({
      id: s.string().id(),
      parentId: s.string().nullable(),
      parent: s
        .toOne(() => node)
        .fields("parentId")
        .references("id"),
      children: s.toMany(() => node),
    });
    const registry = createSchemaRegistry({ node });
    let where: unknown = { id: "one" };
    for (let depth = 0; depth < 40; depth++)
      where = { children: { some: where } };
    expect(() => registry.validate("node", "findMany", { where })).toThrow(
      "Filter nesting exceeds 16 levels"
    );
  });

  it("exports scalar arity, nullability, defaults and explicit required keys", () => {
    const schema = v.object(
      {
        names: v.string({ array: true }),
        age: v.integer({ nullable: true }),
        label: v.string({ default: "default" }),
      },
      { partial: false }
    );
    const exported = toJsonSchema(schema);
    expect(exported.properties).toMatchObject({
      names: { type: "array", items: { type: "string" } },
      age: { anyOf: [{ type: "integer" }, { type: "null" }] },
      label: { type: "string" },
    });
    expect(exported.required).toEqual(["names", "age"]);
    expect(
      schema["~standard"].jsonSchema.output({ target: "draft-2020-12" })
        .required
    ).toEqual(["names", "age", "label"]);
    expect(
      toJsonSchema(
        v.object(
          { required: v.string(), optional: v.string() },
          { atLeast: ["required"] }
        )
      ).required
    ).toEqual(["required"]);
  });
});
