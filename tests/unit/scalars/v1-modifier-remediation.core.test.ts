import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import { nativeTypeFor } from "@schema/scalars/native-types";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { describe, expect, it } from "vitest";

const positive: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "v1",
    validate(value) {
      return typeof value === "number" && value > 0
        ? { value }
        : { issues: [{ message: "positive required" }] };
    },
  },
};
const long: StandardSchemaV1<string> = {
  "~standard": {
    version: 1,
    vendor: "v1",
    validate(value) {
      return typeof value === "string" && value.length > 3
        ? { value }
        : { issues: [{ message: "long required" }] };
    },
  },
};

describe("V1 scalar declaration contracts", () => {
  it("keeps defaults and generated closures through nullable", () => {
    const literal = s.string().default("retained");
    expect(literal.nullable()["~"].state.default).toBe("retained");
    for (const scalar of [
      s.string().id(),
      s.dateTime().now(),
      s.time().now(),
    ]) {
      expect(scalar.nullable()["~"].state.default).toBe(
        scalar["~"].state.default
      );
    }
    expect(s.int().default(7).nullable()["~"].state.default).toBe(7);
    expect(s.boolean().default(false).nullable()["~"].state.default).toBe(
      false
    );
  });

  it("carries refinements through nullable and array reconstruction", () => {
    for (const scalar of [
      s.int().schema(positive),
      s.number().schema(positive),
    ]) {
      expect(parse(scalar.nullable()["~"].state.base, -1).issues).toBeDefined();
      expect(
        parse(scalar.array()["~"].state.base, [1, -1]).issues
      ).toBeDefined();
      expect(
        parse(scalar.array().nullable()["~"].state.base, [1]).issues
      ).toBeUndefined();
    }
    expect(
      parse(s.string().schema(long).array()["~"].state.base, ["okay", "no"])
        .issues
    ).toBeDefined();
  });

  it("formats require values; generation is explicit or follows key role", () => {
    expect(() => s.string().nanoid(0)).toThrow();
    for (const scalar of [
      s.string().uuid(),
      s.string().ulid(),
      s.string().nanoid(),
      s.string().cuid(),
      s.string().uuidv7(),
      s.string().ksuid(),
    ]) {
      expect(scalar["~"].state.hasDefault).toBe(false);
      expect(
        parse(getScalarSchemas(scalar["~"].state).create, undefined).issues
      ).toBeDefined();
    }
    for (const scalar of [
      s.string().uuid().id(),
      s.string().id().uuid(),
      s.string().uuid({ generate: true }),
    ]) {
      expect(scalar["~"].state.hasDefault).toBe(true);
      expect(
        parse(getScalarSchemas(scalar["~"].state).create, undefined).issues
      ).toBeUndefined();
    }
  });

  it("key opt-out and custom defaults survive format order", () => {
    for (const scalar of [
      s.string().id({ generate: false }).uuid(),
      s.string().uuid().id({ generate: false }),
      s.string().id().id({ generate: false }),
    ]) {
      expect(scalar["~"].state.hasDefault).toBe(false);
      expect(scalar["~"].state.default).toBeUndefined();
    }
    const custom = () => "caller";
    expect(s.string().default(custom).id().uuid()["~"].state.default).toBe(
      custom
    );
    expect(
      s.string().uuid({ generate: true }).default(custom).id()["~"].state
        .default
    ).toBe(custom);
  });

  it("coded native maps admit custom types consistently with tagged declarations", () => {
    const scalar = s.string({ pg: { db: "pg", type: "ltree" } });
    expect(nativeTypeFor(scalar["~"].nativeType, "pg")?.type).toBe("ltree");
    expect(nativeTypeFor(scalar.nullable()["~"].nativeType, "pg")?.type).toBe(
      "ltree"
    );
  });

  it("schema documents round-trip domain-only, generated and natural key declarations", () => {
    const schema = {
      record: s.model({
        id: s.string().id({ generate: false }),
        code: s.string().uuid(),
        minted: s.string().uuid({ generate: true }),
      }),
    };
    const document = serializeSchema(schema);
    const restored = parseSchema(document);
    expect(serializeSchema(restored)).toEqual(document);
    const fields = restored.record?.["~"].state.scalars;
    expect(fields?.id?.["~"].state.hasDefault).toBe(false);
    expect(fields?.code?.["~"].state.hasDefault).toBe(false);
    expect(fields?.minted?.["~"].state.hasDefault).toBe(true);
  });
  it("formatted lists admit canonical members in create, set, push and filters", () => {
    const canonical = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    const alias = canonical.toUpperCase();
    for (const field of [
      s.string().uuid().array(),
      s.string().array().uuid(),
    ]) {
      const schemas = getScalarSchemas(field["~"].state);
      expect(parse(schemas.create, [alias])).toEqual({ value: [canonical] });
      expect(parse(schemas.update, { set: [alias] })).toEqual({
        value: { set: [canonical] },
      });
      expect(parse(schemas.update, { push: alias })).toEqual({
        value: { push: [canonical] },
      });
      expect(parse(schemas.update, { unshift: [alias] })).toEqual({
        value: { unshift: [canonical] },
      });
      expect(parse(schemas.filter, { has: alias })).toEqual({
        value: { has: canonical },
      });
      expect(parse(schemas.filter, { hasEvery: [alias] })).toEqual({
        value: { hasEvery: [canonical] },
      });
      expect(parse(schemas.create, ["invalid"]).issues).toBeDefined();
      expect(parse(schemas.update, { push: "invalid" }).issues).toBeDefined();
      expect(parse(schemas.filter, { has: "invalid" }).issues).toBeDefined();
    }
  });

  it("refuses scalar generators on lists in either declaration order", () => {
    expect(() => s.string().uuid({ generate: true }).array()).toThrow(
      "Scalar generation"
    );
    expect(() => s.string().array().uuid({ generate: true })).toThrow(
      "Scalar generation"
    );
    for (const factory of [s.dateTime, s.date, s.time]) {
      expect(() => factory().now().array()).toThrow("Scalar generation");
      expect(() => factory().updatedAt().array()).toThrow("Scalar generation");
      expect(() => factory().array().now()).toThrow("Scalar generation");
      expect(() => factory().array().updatedAt()).toThrow("Scalar generation");
    }
    const instant = "2024-01-02T03:04:05.000Z";
    expect(
      parse(
        getScalarSchemas(s.dateTime().array().default([instant])["~"].state)
          .create,
        undefined
      )
    ).toEqual({ value: [instant] });
    const id = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
    expect(
      parse(
        getScalarSchemas(s.string().uuid().array().default([id])["~"].state)
          .create,
        undefined
      )
    ).toEqual({ value: [id] });
  });
});
