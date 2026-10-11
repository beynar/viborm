import { s } from "@schema";
import { getSchemas } from "@schema/schemas";
import v, { parse, toJsonSchema } from "@validation";
import type { JsonSchema } from "@validation/json-schema";
import { KSUID_MAX_TEXT } from "@validation/primitives/id-formats";
import type { VibSchema } from "@validation/types";
import { describe, expect, test } from "vitest";

/**
 * The exported JSON Schema and the validator agree on every leaf a JSON caller
 * can write (types-14): a string the schema's `pattern` accepts is one the
 * validator accepts, and the other way round. Bigint travels as an integer
 * string, a decimal's declared precision and scale are part of its pattern,
 * and every identifier format is a pattern.
 */

const account = s.model({
  id: s.string().id().ulid(),
  externalId: s.string().uuid(),
  traceId: s.string().uuidv7(),
  publicId: s.string().nanoid(),
  shortId: s.string().nanoid({ length: 10 }),
  slug: s.string().cuid(),
  eventId: s.string().ksuid(),
  ownerRef: s.string().ulid("user"),
  dottedRef: s.string().uuid("a.b"),
  balance: s.decimal({ precision: 10, scale: 2 }),
  whole: s.decimal({ precision: 4, scale: 0 }),
  fraction: s.decimal({ precision: 3, scale: 3 }),
  ledgerTotal: s.bigInt(),
});

const create = getSchemas({ account }).account.scalars;

/** The draft 2020-12 leaf of one field's create schema. */
function leafOf(field: keyof typeof create): {
  schema: VibSchema<unknown, unknown>;
  json: JsonSchema;
} {
  const schema = create[field].create as VibSchema<unknown, unknown>;
  return { schema, json: toJsonSchema(schema, "draft-2020-12") };
}

function patternAccepts(json: JsonSchema, value: string): boolean {
  if (json.type !== "string" || typeof json.pattern !== "string") {
    throw new Error(`not a string pattern: ${JSON.stringify(json)}`);
  }
  return new RegExp(json.pattern, "u").test(value);
}

/** Every sample on which the schema and the validator disagree. */
function disagreements(
  field: keyof typeof create,
  samples: readonly string[]
): string[] {
  const { schema, json } = leafOf(field);
  return samples.filter(
    (value) =>
      patternAccepts(json, value) !==
      (parse(schema, value).issues === undefined)
  );
}

const ULID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const UUID = "550e8400-e29b-41d4-a716-446655440000";

describe("identifier formats are patterns the validator agrees with", () => {
  const cases: readonly [keyof typeof create, readonly string[]][] = [
    [
      "id",
      [
        ULID,
        ULID.toLowerCase(),
        "7ZZZZZZZZZZZZZZZZZZZZZZZZZ",
        "8ZZZZZZZZZZZZZZZZZZZZZZZZZ",
        "01ARZ3NDEKTSV4RRFFQ69G5FA",
        "01ARZ3NDEKTSV4RRFFQ69G5FAI",
        "01ARZ3NDEKTSV4RRFFQ69G5FAU",
        "nope",
      ],
    ],
    [
      "externalId",
      [
        UUID,
        UUID.toUpperCase(),
        "550e8400e29b41d4a716446655440000",
        "{550e8400-e29b-41d4-a716-446655440000}",
        "550e8400-e29b-41d4-a716-44665544000g",
        "nope",
      ],
    ],
    ["traceId", ["0199c4e2-79b0-7f3a-8c21-9f2d6b4a1e08", UUID, "nope"]],
    [
      "publicId",
      [
        "V1StGXR8_Z5jdHi6B-myT",
        "V1StGXR8_Z5jdHi6B-my",
        "V1StGXR8 Z5jdHi6B-myT",
      ],
    ],
    ["shortId", ["V1StGXR8_Z", "V1StGXR8_Z5", "V1StGXR8."]],
    [
      "slug",
      [
        "ajenr87qeqg87w8vjc7xiaie",
        "Ajenr87qeqg87w8vjc7xiaie",
        "1jenr87qeqg87w8vjc7xiaie",
        "short",
      ],
    ],
    [
      "eventId",
      [
        "0ujtsYcgvSTl8PAuAdqWYSMnLOv",
        KSUID_MAX_TEXT,
        `${KSUID_MAX_TEXT.slice(0, -1)}W`,
        `${KSUID_MAX_TEXT.slice(0, 20)}zzzzzzz`,
        "b00000000000000000000000000",
        "zzzzzzzzzzzzzzzzzzzzzzzzzzz",
        "0ujtsYcgvSTl8PAuAdqWYSMnLO",
        "0ujtsYcgvSTl8PAuAdqWYSMnLO-",
      ],
    ],
    [
      "ownerRef",
      [`user-${ULID}`, ULID, "user-nope", `User-${ULID}`, `user-${ULID}x`],
    ],
    ["dottedRef", [`a.b-${UUID}`, `aXb-${UUID}`, UUID]],
  ];

  for (const [field, samples] of cases) {
    test(field, () => {
      expect(disagreements(field, samples)).toEqual([]);
    });
  }
});

describe("a decimal's pattern carries its declared precision and scale", () => {
  const samples = [
    "12.50",
    "1.555",
    "1.5",
    "1.500",
    "1.5000000",
    "-0.01",
    "+0.01",
    "12345678.9",
    "12345678.99",
    "123456789",
    "123456789.1",
    "00012345678.12",
    "0.001",
    "0.000",
    ".5",
    ".",
    "5.",
    "-",
    "",
    "1e3",
    " 1",
    "1,5",
  ];

  test("precision 10, scale 2", () => {
    expect(disagreements("balance", samples)).toEqual([]);
    expect(patternAccepts(leafOf("balance").json, "1.555")).toBe(false);
  });

  test("scale 0 and an all-fraction domain", () => {
    expect(
      disagreements("whole", [...samples, "9999", "10000", "9999.0"])
    ).toEqual([]);
    expect(
      disagreements("fraction", [...samples, "0.999", "0.9999", "1", "0"])
    ).toEqual([]);
  });
});

describe("a bigint is an integer string on both sides", () => {
  const { schema, json } = leafOf("ledgerTotal");

  test("the export is an integer-pattern string, not a JSON integer", () => {
    expect(json.type).toBe("string");
    expect(json).not.toHaveProperty("format");
    for (const value of ["0", "-42", "+7", "12345678901234567890"]) {
      expect(patternAccepts(json, value)).toBe(true);
    }
    for (const value of ["1.5", "x", "", "1e3", " 1", "0x10", "-"]) {
      expect(patternAccepts(json, value)).toBe(false);
    }
  });

  test("the validator admits what the export admits, as a bigint", () => {
    expect(parse(schema, "12345678901234567890")).toEqual({
      value: 12_345_678_901_234_567_890n,
    });
    expect(parse(schema, "-42")).toEqual({ value: -42n });
    expect(parse(schema, 5n)).toEqual({ value: 5n });
    for (const value of ["1.5", "x", "", "1e3", " 1", "0x10", "-", 1, 1.5]) {
      expect(parse(schema, value).issues).toBeDefined();
    }
  });

  test("filters and updates take the same integer string", () => {
    const where = getSchemas({ account }).account.core.where;
    expect(parse(where, { ledgerTotal: { gt: "10" } })).toEqual({
      value: { ledgerTotal: { gt: 10n } },
    });
    const bare = toJsonSchema(v.bigint({ array: true }));
    expect(bare).toMatchObject({ type: "array", items: { type: "string" } });
  });
});

describe("every operation of a model graph has a JSON Schema", () => {
  test("a polymorphic graph converts without a refusal", () => {
    const post = s.model({ id: s.string().id(), title: s.string() });
    const video = s.model({ id: s.string().id(), seconds: s.int() });
    const gallery = s.model({
      id: s.string().id(),
      items: s.toMany(
        { post: () => post, video: () => video },
        { values: { post: "post", video: "video" } }
      ),
    });
    const args = getSchemas({ post, video, gallery }).gallery.args;
    for (const operation of Object.keys(args) as (keyof typeof args)[]) {
      expect(() =>
        toJsonSchema(args[operation] as VibSchema, "draft-2020-12")
      ).not.toThrow();
    }
    const select = toJsonSchema(
      getSchemas({ post, video, gallery }).gallery.core.select as VibSchema
    );
    expect(JSON.stringify(select)).toContain('"uniqueItems":true');
  });
});
