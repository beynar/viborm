import { s } from "@schema";
import { parseSchema, serializeSchema } from "@schema/json";
import { AnyNull, DbNull, JsonNull } from "@schema/json-null";
import { parse } from "@validation";
import { getScalarSchemas } from "@validation/scalars";
import { expect, test, vi } from "vitest";

test("JSON defaults distinguish JSON null from SQL NULL and preserve caller refusal", () => {
  for (const field of [
    s.json().default(null),
    s.json().default(JsonNull),
    s.json().default(JsonNull).nullable(),
    s.json().nullable().default(JsonNull),
  ]) {
    const schema = getScalarSchemas(field["~"].state).create;
    expect(parse(schema, undefined)).toEqual({ value: JsonNull });
    expect(parse(schema, null).issues).toBeDefined();
    expect(parse(schema, JsonNull)).toEqual({ value: JsonNull });
    expect(() => s.model({ id: s.string().id(), value: field })).not.toThrow();
  }
  for (const field of [
    s.json().nullable(),
    s.json().nullable().default(null),
    s.json().nullable().default(DbNull),
  ]) {
    const schema = getScalarSchemas(field["~"].state).create;
    const result = parse(schema, undefined);
    if (result.issues) throw new Error(result.issues[0]?.message);
    expect(result.value).toBe(field["~"].state.default);
  }
  // @ts-expect-error - AnyNull is a filter question, not a default value
  expect(() => s.json().default(AnyNull)).toThrow();
  // @ts-expect-error - the database NULL requires a nullable column
  expect(() => s.json().default(DbNull)).toThrow();
});

test("default factories resolve once and contain failures", () => {
  const factory = vi.fn(() => JsonNull);
  expect(
    parse(
      getScalarSchemas(s.json().default(factory)["~"].state).create,
      undefined
    )
  ).toEqual({ value: JsonNull });
  expect(factory).toHaveBeenCalledOnce();
  const invalid = vi.fn(() => undefined);
  expect(
    parse(
      // @ts-expect-error - hostile callers can return an inadmissible default
      getScalarSchemas(s.json().default(invalid)["~"].state).create,
      undefined
    ).issues
  ).toBeDefined();
  expect(invalid).toHaveBeenCalledOnce();
  expect(
    parse(
      getScalarSchemas(
        s.json().default(() => {
          throw new Error("failure");
        })["~"].state
      ).create,
      undefined
    ).issues
  ).toBeDefined();
});

test("a transformed JSON null stays a document in explicit and defaulted writes", () => {
  const field = s.json().schema({
    "~standard": {
      version: 1,
      vendor: "fixture",
      validate: () => ({ value: null }),
    },
  });
  for (const scalar of [field, field.nullable()]) {
    const schemas = getScalarSchemas(scalar["~"].state);
    expect(parse(schemas.create, { input: true })).toEqual({ value: JsonNull });
    expect(parse(schemas.update, { set: { input: true } })).toEqual({
      value: { set: JsonNull },
    });
  }
  for (const scalar of [
    field.default({ input: true }),
    field.nullable().default({ input: true }),
  ]) {
    expect(
      parse(getScalarSchemas(scalar["~"].state).create, undefined)
    ).toEqual({ value: JsonNull });
  }
});

test("existing JSON null default sentinels survive schema document round trips", () => {
  const schema = {
    record: s.model({
      id: s.string().id(),
      required: s.json().default(JsonNull),
      optional: s.json().nullable().default(JsonNull),
      absent: s.json().nullable().default(DbNull),
    }),
  };
  const document = serializeSchema(schema);
  const restored = parseSchema(document);
  expect(serializeSchema(restored)).toEqual(document);
  const fields = restored.record?.["~"].state.scalars;
  expect(fields?.required?.["~"].state.default).toBe(JsonNull);
  expect(fields?.optional?.["~"].state.default).toBe(JsonNull);
  expect(fields?.absent?.["~"].state.default).toBe(DbNull);
});
