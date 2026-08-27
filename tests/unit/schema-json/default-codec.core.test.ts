/**
 * The default codec: one recursive, detached, cycle-aware conversion, both
 * directions.
 *
 * A default is the only place a document holds a value from a domain the FIELD
 * chose rather than the format — a `bigint`, a `Date`, a byte string, or an
 * arbitrarily nested JSON structure containing them. The codec is what makes
 * that domain expressible in JSON without the four failures a positional
 * envelope has: it cannot reach a nested value, it cannot tell a `Date` from
 * the string that spells it, it hands back the caller's own object, and a key
 * named `__proto__` stops being data.
 *
 * Each tag is an exactly-one-key object, and `$raw` is how a literal whose own
 * shape collides with a tag says so.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import type { SchemaDocument } from "@schema/json";
import { parseSchema, serializeSchema } from "@schema/json";
import type { Scalar } from "@schema/scalars/base";
import type { JsonValue } from "@validation/primitives/json";
import { describe, expect, it } from "vitest";

const ISO = "2020-01-02T03:04:05.000Z";

function withProbe(field: unknown) {
  return {
    version: 1,
    models: {
      user: { fields: { id: { type: "string", id: true }, probe: field } },
    },
  };
}

function model(probe: Scalar): Schema {
  return { user: s.model({ id: s.string().id(), probe }) };
}

/** The document node one coded field denotes. */
function emitted(schema: Schema): unknown {
  return serializeSchema(schema).models.user?.fields.probe;
}

/** Just the `default` of that node. */
function emittedDefault(schema: Schema): unknown {
  const field = serializeSchema(schema).models.user?.fields.probe;
  if (field === undefined || !("default" in field)) {
    throw new Error("the probe field carries a default");
  }
  return field.default;
}

/** The value a document's default binds into declaration state. */
function boundDefault(field: unknown): unknown {
  const schema = parseSchema(withProbe(field));
  return schema.user?.["~"].state.scalars.probe?.["~"].state.default;
}

function canonical(field: unknown): SchemaDocument {
  return serializeSchema(parseSchema(withProbe(field)));
}

function parseRefusal(field: unknown): ValidationError {
  try {
    parseSchema(withProbe(field));
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("parseSchema accepted a default it must refuse");
}

function serializeRefusal(schema: Schema): ValidationError {
  try {
    serializeSchema(schema);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("serializeSchema accepted a default it must refuse");
}

function issues(error: ValidationError): string[] {
  return error.issues.map(
    (issue) => `${issue.message.slice(0, 6)} ${issue.path}`
  );
}

describe("tagged leaves", () => {
  it("writes and reads a bigint as `$bigint`", () => {
    expect(emitted(model(s.bigInt().default(5n)))).toEqual({
      type: "bigint",
      default: { $bigint: "5" },
    });
    expect(boundDefault({ type: "bigint", default: { $bigint: "5" } })).toBe(
      5n
    );
  });

  it("writes and reads bytes as `$bytes`", () => {
    expect(emitted(model(s.blob().default(new Uint8Array([1, 2, 3]))))).toEqual(
      {
        type: "blob",
        default: { $bytes: "AQID" },
      }
    );
    expect(boundDefault({ type: "blob", default: { $bytes: "AQID" } })).toEqual(
      new Uint8Array([1, 2, 3])
    );
  });

  it("writes and reads a Date as `$date`", () => {
    expect(emitted(model(s.dateTime().default(new Date(ISO))))).toEqual({
      type: "datetime",
      default: { $date: ISO },
    });
    const back = boundDefault({ type: "datetime", default: { $date: ISO } });
    expect(back).toBeInstanceOf(Date);
    expect(back).toEqual(new Date(ISO));
  });

  /**
   * The distinction the tag exists for. A temporal field takes `string | Date`,
   * and downstream the two are NOT the same declaration: DDL emits a string
   * default as a SQL `DEFAULT` clause and leaves a `Date` to the application. A
   * bare ISO string therefore stays a string, and only `$date` makes a `Date`.
   */
  it("keeps a bare ISO string on a temporal field a string", () => {
    expect(emitted(model(s.dateTime().default(ISO)))).toEqual({
      type: "datetime",
      default: ISO,
    });
    expect(boundDefault({ type: "datetime", default: ISO })).toBe(ISO);
  });

  it.each([
    ["a bigint that is not a decimal integer", "bigint", { $bigint: "4.2" }],
    ["a bigint payload that is not a string", "bigint", { $bigint: 5 }],
    ["a date that names no instant", "datetime", { $date: "not a date" }],
    ["a date payload that is not a string", "datetime", { $date: 5 }],
    ["bytes that are not base64", "blob", { $bytes: "!!!!" }],
    ["a bytes payload that is not a string", "blob", { $bytes: 5 }],
  ])("refuses %s", (_label, type, value) => {
    expect(issues(parseRefusal({ type, default: value }))).toEqual([
      "[J008] /models/user/fields/probe/default",
    ]);
  });

  it("refuses an unknown `$`-tag rather than reading it as a literal", () => {
    expect(
      issues(parseRefusal({ type: "json", default: { $decimal: "1.5" } }))
    ).toEqual(["[J008] /models/user/fields/probe/default"]);
  });
});

describe("recursion", () => {
  /**
   * The probe a positional envelope cannot answer: the special value is not at
   * the top of the default, so nothing at the top could have encoded it — and
   * the document that resulted was not JSON at all.
   */
  it("reaches a special value nested inside a default", () => {
    const field = {
      type: "bigint",
      array: true,
      default: [{ $bigint: "1" }, { $bigint: "2" }],
    };
    expect(boundDefault(field)).toEqual([1n, 2n]);
    const back = canonical(field);
    expect(back.models.user?.fields.probe).toEqual(field);
    expect(() => JSON.stringify(back)).not.toThrow();
  });

  it("leaves an ordinary JSON structure alone", () => {
    const seed = { a: [1, null, true], b: { c: "x" } };
    expect(emittedDefault(model(s.json().default(seed)))).toEqual(seed);
    expect(boundDefault({ type: "json", default: seed })).toEqual(seed);
  });

  /**
   * A literal whose own shape is a tag's shape. Without an escape the document
   * would read `{"$date": "x"}` back as a `Date`, so the encoder says which one
   * it meant.
   */
  it("escapes a literal that collides with a tag", () => {
    const collision = { $date: "x" };
    expect(emittedDefault(model(s.json().default(collision)))).toEqual({
      $raw: { $date: "x" },
    });
    expect(
      boundDefault({ type: "json", default: { $raw: { $date: "x" } } })
    ).toEqual(collision);
  });

  it("escapes a literal that collides with the escape itself", () => {
    const collision = { $raw: { $date: "x" } };
    const written = emittedDefault(model(s.json().default(collision)));
    expect(written).toEqual({ $raw: { $raw: { $raw: { $date: "x" } } } });
    expect(boundDefault({ type: "json", default: written })).toEqual(collision);
  });

  it("escapes a collision nested inside an ordinary structure", () => {
    const seed = { list: [{ $bigint: "1" }], plain: 1 };
    const written = emittedDefault(model(s.json().default(seed)));
    expect(written).toEqual({
      list: [{ $raw: { $bigint: "1" } }],
      plain: 1,
    });
    expect(boundDefault({ type: "json", default: written })).toEqual(seed);
  });

  it("leaves a two-key object that merely mentions a tag alone", () => {
    const seed = { $date: "x", other: 1 };
    expect(emittedDefault(model(s.json().default(seed)))).toEqual(seed);
    expect(boundDefault({ type: "json", default: seed })).toEqual(seed);
  });

  it("reads a bare `$raw` payload as the literal it wraps", () => {
    expect(boundDefault({ type: "json", default: { $raw: 1 } })).toBe(1);
    expect(boundDefault({ type: "json", default: { $raw: null } })).toBe(null);
    expect(boundDefault({ type: "json", default: { $raw: [1, 2] } })).toEqual([
      1, 2,
    ]);
  });
});

describe("detachment", () => {
  /**
   * A document is a value the caller owns and will edit. Handing back the
   * scalar's own object means a document edit reaches into the declaration
   * state of a schema the caller only asked to DUMP.
   */
  it("copies out of scalar state, so editing a document cannot reach it", () => {
    const seed = { nested: { list: [1, 2] } };
    const schema = model(s.json().default(seed));
    const written = emittedDefault(schema);
    if (written === null || typeof written !== "object") {
      throw new Error("the default is an object");
    }
    const reached: Record<string, { list: number[] }> = Object.assign(
      Object.create(null),
      written
    );
    reached.nested?.list.push(3);
    expect(seed).toEqual({ nested: { list: [1, 2] } });
    expect(emittedDefault(schema)).toEqual({ nested: { list: [1, 2] } });
  });

  it("copies into declaration state, so editing the document cannot reach it", () => {
    const seed = { nested: { list: [1, 2] } };
    const schema = parseSchema(withProbe({ type: "json", default: seed }));
    seed.nested.list.push(3);
    expect(schema.user?.["~"].state.scalars.probe?.["~"].state.default).toEqual(
      { nested: { list: [1, 2] } }
    );
  });

  it("gives two parses of one document independent defaults", () => {
    const field = { type: "json", default: { list: [1] } };
    const first = parseSchema(withProbe(field));
    const second = parseSchema(withProbe(field));
    expect(first.user?.["~"].state.scalars.probe?.["~"].state.default).not.toBe(
      second.user?.["~"].state.scalars.probe?.["~"].state.default
    );
  });

  it("copies a byte string rather than aliasing it", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const first = boundDefault({ type: "blob", default: { $bytes: "AQID" } });
    const second = boundDefault({ type: "blob", default: { $bytes: "AQID" } });
    expect(first).not.toBe(second);
    expect(first).toEqual(bytes);
  });
});

describe("`__proto__` is data", () => {
  /**
   * `record["__proto__"] = value` SETS A PROTOTYPE and creates no own key, so a
   * default written that way loses the entry entirely — silently, because what
   * is left is a well-formed empty object. Every record the codec builds is
   * constructed key by key instead.
   */
  it("keeps an own `__proto__` key through a parse", () => {
    const hostile = JSON.parse('{"__proto__":"text","ok":1}');
    const value = boundDefault({ type: "json", default: hostile });
    if (value === null || typeof value !== "object") {
      throw new Error("the default is an object");
    }
    expect(Object.keys(value)).toEqual(["__proto__", "ok"]);
    expect(Object.getOwnPropertyDescriptor(value, "__proto__")?.value).toBe(
      "text"
    );
    expect(Object.getPrototypeOf(value)).toBe(null);
  });

  it("keeps an own `__proto__` key through a serialization", () => {
    const hostile = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(
      JSON.stringify(emittedDefault(model(s.json().default(hostile))))
    ).toBe('{"__proto__":{"polluted":true}}');
  });
});

describe("values the document cannot hold", () => {
  /**
   * A prototype-carrying object is a fact the document has no way to state: its
   * class, its accessors and its non-enumerable state would all be dropped, and
   * a round trip would hand back a different value. Named, never dropped.
   */
  it("names the field whose default carries a prototype", () => {
    class Coordinate {
      x = 1;
      y = 2;
    }
    expect(
      issues(serializeRefusal(model(s.point().default(new Coordinate()))))
    ).toEqual(["[J009] /models/user/fields/probe/default"]);
  });

  // An invalid Date has no ISO spelling at all: `toISOString` throws on it.
  it("names the field whose default is a Date naming no instant", () => {
    expect(
      issues(serializeRefusal(model(s.dateTime().default(new Date("nope")))))
    ).toEqual(["[J009] /models/user/fields/probe/default"]);
  });

  // `JSON.stringify` turns a non-finite number into `null`, which is a silent
  // change of value — the one outcome a refusal exists to prevent.
  it("names the field whose default holds a non-finite number", () => {
    expect(
      issues(
        serializeRefusal(
          model(s.json().default({ n: Number.POSITIVE_INFINITY }))
        )
      )
    ).toEqual(["[J009] /models/user/fields/probe/default/n"]);
  });

  it("refuses a cyclic array default on the way out, rather than exhausting the stack", () => {
    const cyclic: JsonValue[] = [];
    cyclic.push(cyclic);
    const error = serializeRefusal(model(s.json().default({ seed: cyclic })));
    expect(issues(error)).toEqual([
      "[J009] /models/user/fields/probe/default/seed/0",
    ]);
    expect(error.issues[0]?.message).toContain("cycle");
  });

  it("refuses a cyclic object default on the way out", () => {
    const cyclic: Record<string, JsonValue> = {};
    cyclic.self = cyclic;
    expect(
      issues(serializeRefusal(model(s.json().default({ seed: cyclic }))))
    ).toEqual(["[J009] /models/user/fields/probe/default/seed/self"]);
  });
});

describe("canonical form", () => {
  it("is a fixed point over every tag", () => {
    for (const field of [
      { type: "bigint", default: { $bigint: "7" } },
      { type: "datetime", default: { $date: ISO } },
      { type: "datetime", default: ISO },
      { type: "blob", default: { $bytes: "AQID" } },
      { type: "json", default: { $raw: { $date: "x" } } },
      { type: "json", default: { a: [1, { b: null }] } },
    ]) {
      const once = canonical(field);
      expect(serializeSchema(parseSchema(once))).toEqual(once);
    }
  });
});
