/**
 * Hostile and malformed documents.
 *
 * `parseSchema` takes JSON TEXT or a caller-built object, and an agent-written
 * document is untrusted input by construction. Every case below names the one
 * thing it alone catches; the aggregate assertions at the end pin the error
 * posture the whole family shares.
 */

import { ValidationError } from "@errors";
import type { SchemaJsonOptions } from "@schema/json";
import { parseSchema, serializeSchema } from "@schema/json";
import {
  MYSQL,
  type NativeType,
  PG,
  SQLITE,
} from "@schema/scalars/native-types";
import { VibORMErrorCode } from "@src/errors/base";
import { describe, expect, it } from "vitest";

function refusal(input: string | object): ValidationError {
  try {
    parseSchema(input);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("parseSchema accepted a document it must refuse");
}

/** Every issue rendered as `<code> <pointer>`, the pair a reader acts on. */
function issues(error: ValidationError): string[] {
  return error.issues.map(
    (issue) => `${issue.message.slice(0, 6)} ${issue.path}`
  );
}

function codes(error: ValidationError): string[] {
  return error.issues.map((issue) => issue.message.slice(1, 5));
}

const MINIMAL = {
  version: 1,
  models: { user: { fields: { id: { type: "string", id: true } } } },
};

const UNKNOWN_OPTION = /J003/;

/** The smallest legal `fields` bag, for documents probing something else. */
const ID_ONLY = { id: { type: "string", id: true } };

function withUserField(field: unknown) {
  return {
    version: 1,
    models: {
      user: { fields: { id: { type: "string", id: true }, probe: field } },
    },
  };
}

describe("input", () => {
  it("wraps a JSON syntax error into the J-code family", () => {
    const error = refusal("{ not json");
    expect(codes(error)).toEqual(["J001"]);
    expect(error.issues[0]?.path).toBe("");
  });

  it("refuses a document that is not an object", () => {
    expect(codes(refusal("[]"))).toEqual(["J004"]);
    expect(codes(refusal(JSON.stringify(null)))).toEqual(["J004"]);
  });

  it("refuses a hostile prototype rather than reading inherited entries", () => {
    const hostile = Object.create({ version: 1, models: {} });
    expect(codes(refusal(hostile))).toEqual(["J004"]);
  });

  it("owns the refusal when a caller-built accessor throws", () => {
    const models = {
      get user() {
        throw new Error("boom");
      },
    };
    const error = refusal({ version: 1, models });
    expect(issues(error)).toEqual(["[J004] /models/user"]);
  });

  it("names the supported set for an unknown version", () => {
    const error = refusal({ ...MINIMAL, version: 2 });
    expect(issues(error)).toEqual(["[J002] /version"]);
    expect(error.issues[0]?.message).toContain("version 1");
  });

  it("refuses an unknown top-level key", () => {
    expect(issues(refusal({ ...MINIMAL, client: {} }))).toEqual([
      "[J003] /client",
    ]);
  });
});

describe("prototype pollution", () => {
  // `registry["__proto__"] = model` would SET a prototype and create no own
  // key, so `Object.entries` in hydration would see nothing at all and the
  // identifier rule that runs there would never fire. The rule has to run at
  // the first boundary that reads the key — before the registry is written.
  it("refuses a __proto__ model key before anything is constructed", () => {
    const document = JSON.parse(
      '{"version":1,"models":{"__proto__":{"fields":{"id":{"type":"string"}}}}}'
    );
    expect(issues(refusal(document))).toEqual(["[J005] /models/__proto__"]);
  });

  it("refuses __proto__ in every other identifier slot", () => {
    const document = JSON.parse(`{
      "version": 1,
      "enums": { "__proto__": { "values": ["a"] } },
      "models": {
        "user": {
          "fields": {
            "__proto__": { "type": "string" },
            "topic": { "type": "toOne", "variants": { "__proto__": "user" } }
          }
        }
      }
    }`);
    expect(issues(refusal(document))).toEqual([
      "[J005] /models/user/fields/__proto__",
      "[J005] /models/user/fields/topic/variants/__proto__",
      "[J005] /enums/__proto__",
    ]);
  });

  // A `__proto__` key in a `values` or `through` map would set the prototype of
  // the record being read into and create no entry at all, so the factory's own
  // exactness rule could only report it as a key that is MISSING.
  it("refuses __proto__ in a `values` and a `through` map", () => {
    const document = JSON.parse(`{
      "version": 1,
      "models": {
        "user": {
          "fields": {
            "one": { "type": "toOne", "variants": { "a": "user" },
                     "values": { "__proto__": "x" } },
            "many": { "type": "toMany", "variants": { "a": "user" },
                      "through": { "__proto__": { "table": "t", "source": "s", "target": "g" } } }
          }
        }
      }
    }`);
    expect(issues(refusal(document))).toEqual([
      "[J005] /models/user/fields/one/values/__proto__",
      "[J005] /models/user/fields/many/through/__proto__",
    ]);
  });

  it("refuses a key that is not a schema identifier", () => {
    expect(
      issues(refusal({ version: 1, models: { "user-1": { fields: {} } } }))
    ).toEqual(["[J005] /models/user-1"]);
  });
});

describe("node shape", () => {
  it("refuses an unknown key beside a real one", () => {
    const error = refusal(withUserField({ type: "string", uniqu: true }));
    expect(issues(error)).toEqual(["[J003] /models/user/fields/probe/uniqu"]);
  });

  it("refuses a wrong-typed modifier value", () => {
    const error = refusal(withUserField({ type: "string", nullable: "yes" }));
    expect(issues(error)).toEqual([
      "[J004] /models/user/fields/probe/nullable",
    ]);
  });

  it("refuses an unknown field type", () => {
    expect(issues(refusal(withUserField({ type: "text" })))).toEqual([
      "[J004] /models/user/fields/probe/type",
    ]);
  });

  it("refuses an unknown generator kind and dialect", () => {
    expect(
      issues(
        refusal(
          withUserField({
            type: "string",
            generate: { kind: "snowflake" },
            native: { db: "oracle", type: "varchar2" },
          })
        )
      )
    ).toEqual([
      "[J004] /models/user/fields/probe/native/db",
      "[J004] /models/user/fields/probe/generate/kind",
    ]);
  });

  it("refuses an index type outside the union", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: { id: { type: "string", id: true } },
          indexes: [{ fields: ["id"], type: "brin" }],
        },
      },
    });
    expect(issues(error)).toEqual(["[J004] /models/user/indexes/0/type"]);
  });

  /**
   * "All at once" is the claim this boundary is FOR: it is the only place that
   * knows where in an artifact each fact was written, so a walk that stopped at
   * the first bad one would send an author round the loop once per mistake.
   * Two places used to stop early.
   */
  it("reports every bad element of one array, not just the first", () => {
    expect(
      issues(
        refusal({
          version: 1,
          models: { user: { fields: {}, omit: [1, 2] } },
        })
      )
    ).toEqual(["[J004] /models/user/omit/0", "[J004] /models/user/omit/1"]);
  });

  it("reports the sibling keys of a field whose `type` is unknown", () => {
    expect(
      issues(refusal(withUserField({ type: "nope", bogus: true })))
    ).toEqual([
      "[J004] /models/user/fields/probe/type",
      "[J003] /models/user/fields/probe/bogus",
    ]);
  });

  /**
   * An unknown `type` means the ARM is unknown, so the keys reported are the
   * ones no arm has. `fields` belongs to a `toOne`, `nullable` to a scalar:
   * neither can be called unknown while the arm is undecided.
   */
  it("reports only the keys no field arm declares", () => {
    expect(
      issues(
        refusal(
          withUserField({
            type: "nope",
            fields: ["a"],
            nullable: true,
            bogus: true,
          })
        )
      )
    ).toEqual([
      "[J004] /models/user/fields/probe/type",
      "[J003] /models/user/fields/probe/bogus",
    ]);
  });

  it("collects every issue in the document and throws once", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: {
            a: { type: "string", nullable: 1 },
            b: { type: "nope" },
            c: { type: "string", bogus: true },
          },
        },
        "bad-key": { fields: {} },
      },
    });
    expect(issues(error)).toEqual([
      "[J004] /models/user/fields/a/nullable",
      "[J004] /models/user/fields/b/type",
      "[J003] /models/user/fields/c/bogus",
      "[J005] /models/bad-key",
    ]);
    expect(error.code).toBe(VibORMErrorCode.INVALID_INPUT);
    expect(error.source).toEqual({
      kind: "schema-builder",
      builder: "schema-json",
      path: "",
    });
    expect(error.message).toContain("schema-json");
  });
});

describe("references", () => {
  it("refuses a relation target that no model declares", () => {
    const error = refusal(withUserField({ type: "toOne", target: "ghost" }));
    expect(issues(error)).toEqual(["[J006] /models/user/fields/probe/target"]);
  });

  it("refuses a variant target that no model declares", () => {
    const error = refusal(
      withUserField({ type: "toMany", variants: { a: "ghost" } })
    );
    expect(issues(error)).toEqual([
      "[J006] /models/user/fields/probe/variants/a",
    ]);
  });

  it("refuses an `omit` entry that is not a scalar of the model", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: {
            id: { type: "string", id: true },
            posts: { type: "toMany", target: "user" },
          },
          omit: ["secrets", "posts"],
        },
      },
    });
    expect(issues(error)).toEqual([
      "[J006] /models/user/omit/0",
      "[J006] /models/user/omit/1",
    ]);
  });

  it("refuses a dangling `enums` reference and a missing one", () => {
    expect(
      issues(refusal(withUserField({ type: "enum", enum: "ghost" })))
    ).toEqual(["[J006] /models/user/fields/probe/enum"]);
    expect(issues(refusal(withUserField({ type: "enum" })))).toEqual([
      "[J004] /models/user/fields/probe/enum",
    ]);
  });

  it("refuses `enum` on a field that is not an enum", () => {
    expect(
      issues(refusal(withUserField({ type: "string", enum: ["a"] })))
    ).toEqual(["[J003] /models/user/fields/probe/enum"]);
  });
});

describe("relation arms", () => {
  it("refuses a slot that names both target domains, or neither", () => {
    expect(
      issues(
        refusal(
          withUserField({
            type: "toOne",
            target: "user",
            variants: { a: "user" },
          })
        )
      )
    ).toEqual(["[J004] /models/user/fields/probe"]);
    expect(issues(refusal(withUserField({ type: "toMany" })))).toEqual([
      "[J004] /models/user/fields/probe",
    ]);
  });

  it("refuses a key that belongs to another arm", () => {
    expect(
      issues(
        refusal(
          withUserField({ type: "toMany", target: "user", fields: ["id"] })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/fields"]);
    expect(
      issues(
        refusal(
          withUserField({
            type: "toOne",
            variants: { a: "user" },
            through: { a: { table: "t", source: "s", target: "g" } },
          })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/through"]);
    expect(
      issues(
        refusal(
          withUserField({
            type: "toMany",
            variants: { a: "user" },
            optional: true,
          })
        )
      )
    ).toEqual(["[J003] /models/user/fields/probe/optional"]);
  });

  // Trusted junction state is `AtLeastOne`: it stores an override only when one
  // was declared, so `{}` becomes no builder call at all and nothing downstream
  // could refuse it.
  it("refuses an empty `junction`", () => {
    expect(
      issues(
        refusal(withUserField({ type: "toMany", target: "user", junction: {} }))
      )
    ).toEqual(["[J004] /models/user/fields/probe/junction"]);
  });

  it("refuses `setNull` on a junction and an unknown referential action", () => {
    expect(
      issues(
        refusal(
          withUserField({
            type: "toMany",
            target: "user",
            junction: { onDelete: "setNull" },
          })
        )
      )
    ).toEqual(["[J004] /models/user/fields/probe/junction/onDelete"]);
    expect(
      issues(
        refusal(
          withUserField({ type: "toOne", target: "user", onDelete: "cascde" })
        )
      )
    ).toEqual(["[J004] /models/user/fields/probe/onDelete"]);
  });

  it("hands a partial `values` bag to the factory that owns exactness", () => {
    const error = refusal(
      withUserField({
        type: "toOne",
        variants: { a: "user", b: "user" },
        values: { a: "a" },
      })
    );
    expect(issues(error)).toEqual(["[J010] /models/user/fields/probe"]);
    expect(error.issues[0]?.message).toContain("exact over the variant keys");
    // The builder's own refusal is kept as the cause (the error framework
    // redacts its message); this boundary only attached the document location.
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("hands an incomplete foreign key to the model boundary", () => {
    const error = refusal(
      withUserField({ type: "toOne", target: "user", fields: ["id"] })
    );
    expect(codes(error)).toEqual(["J010"]);
    expect(error.issues[0]?.message).toContain("without `.references(...)`");
  });

  it("hands a compound key member the model does not have to the builder", () => {
    const document = {
      version: 1,
      models: {
        user: {
          fields: { region: { type: "string" }, slug: { type: "string" } },
          ids: [{ fields: ["region", "slgu"] }],
        },
      },
    };
    const error = refusal(document);
    expect(issues(error)).toEqual(["[J010] /models/user/ids/0"]);
    expect(error.issues[0]?.message).toContain(
      "Compound ID field 'slgu' does not exist"
    );
  });

  it("hands a junction token that is not an identifier to the builder", () => {
    const error = refusal(
      withUserField({
        type: "toMany",
        target: "user",
        junction: { table: "post tags" },
      })
    );
    expect(issues(error)).toEqual([
      "[J010] /models/user/fields/probe/junction/table",
    ]);
  });
});

describe("modifier legality", () => {
  it("refuses a modifier the scalar class does not have", () => {
    expect(
      issues(refusal(withUserField({ type: "json", array: true })))
    ).toEqual(["[J007] /models/user/fields/probe/array"]);
    expect(
      issues(refusal(withUserField({ type: "boolean", id: true })))
    ).toEqual(["[J007] /models/user/fields/probe/id"]);
    expect(
      issues(refusal(withUserField({ type: "point", unique: true })))
    ).toEqual(["[J007] /models/user/fields/probe/unique"]);
    expect(
      issues(
        refusal(withUserField({ type: "string", generate: { kind: "now" } }))
      )
    ).toEqual(["[J007] /models/user/fields/probe/generate"]);
  });

  // Blob refuses its three by THROWING rather than by not having the method.
  it("re-throws a blob's deliberate refusal with the document path", () => {
    const error = refusal(withUserField({ type: "blob", array: true }));
    expect(issues(error)).toEqual(["[J010] /models/user/fields/probe/array"]);
    expect(error.issues[0]?.message).toContain(
      "Blob scalars don't support array modifier"
    );
  });

  it("refuses a generator argument the generator does not take", () => {
    expect(
      issues(
        refusal(
          withUserField({
            type: "int",
            generate: { kind: "increment", prefix: "x" },
          })
        )
      )
    ).toEqual(["[J007] /models/user/fields/probe/generate"]);
    expect(
      issues(
        refusal(
          withUserField({
            type: "string",
            generate: { kind: "ulid", length: 8 },
          })
        )
      )
    ).toEqual(["[J007] /models/user/fields/probe/generate"]);
  });
});

describe("defaults", () => {
  // A default BYPASSES validation downstream, so a wrong-typed one would
  // otherwise survive to bind time.
  it("refuses a default outside the field's own domain", () => {
    expect(
      issues(refusal(withUserField({ type: "int", default: "seven" })))
    ).toEqual(["[J008] /models/user/fields/probe/default"]);
    expect(
      issues(
        refusal(withUserField({ type: "enum", enum: ["a"], default: "b" }))
      )
    ).toEqual(["[J008] /models/user/fields/probe/default"]);
    expect(
      issues(refusal(withUserField({ type: "string", default: null })))
    ).toEqual(["[J008] /models/user/fields/probe/default"]);
  });

  /**
   * A tag, and nothing else. An untagged decimal string on a `bigint` field is
   * a STRING, which the field's own domain refuses — the codec never guesses a
   * domain from the field, because guessing is what made a `Date` default and
   * the string spelling it indistinguishable. The tags themselves are witnessed
   * in `default-codec.core.test.ts`.
   */
  it("takes a bigint default as `$bigint` and nothing else", () => {
    expect(
      serializedDefault({ type: "bigint", default: { $bigint: "42" } })
    ).toBe(42n);
    for (const value of [42, "42", "4.2"]) {
      expect(
        issues(refusal(withUserField({ type: "bigint", default: value })))
      ).toEqual(["[J008] /models/user/fields/probe/default"]);
    }
  });

  it("takes a blob default as `$bytes` and nothing else", () => {
    expect(
      serializedDefault({ type: "blob", default: { $bytes: "AQID" } })
    ).toEqual(new Uint8Array([1, 2, 3]));
    expect(
      issues(refusal(withUserField({ type: "blob", default: "AQID" })))
    ).toEqual(["[J008] /models/user/fields/probe/default"]);
  });

  it("refuses a function default, which JSON cannot hold", () => {
    const error = refusal(
      withUserField({ type: "datetime", default: () => new Date() })
    );
    expect(issues(error)).toEqual(["[J004] /models/user/fields/probe/default"]);
    expect(error.issues[0]?.message).toContain("`generate`");
  });

  it("refuses a non-JSON value nested inside a default", () => {
    expect(
      issues(refusal(withUserField({ type: "json", default: { a: [1n] } })))
    ).toEqual(["[J004] /models/user/fields/probe/default/a/0"]);
    expect(
      issues(
        refusal(
          withUserField({ type: "json", default: Number.POSITIVE_INFINITY })
        )
      )
    ).toEqual(["[J004] /models/user/fields/probe/default"]);
  });

  /**
   * An unknown `$`-tag is a DOCUMENT-shape fact, caught during the accumulating
   * walk, not at decode time — so two bad tags in two fields yield two `J008`
   * issues in one throw. Fail-fast decoding reported only the first.
   */
  it("collects an unknown default tag from every field, not just the first", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: {
            id: { type: "string", id: true },
            a: { type: "json", default: { $one: 1 } },
            b: { type: "json", default: { $two: 2 } },
          },
        },
      },
    });
    expect(issues(error)).toEqual([
      "[J008] /models/user/fields/a/default",
      "[J008] /models/user/fields/b/default",
    ]);
  });

  /**
   * Object input can carry `key: undefined`; JSON text cannot. Since object
   * input describes exactly what JSON text can, an own property whose value is
   * `undefined` is refused — absence is spelled by omitting the key. Read as
   * absent, it silently became a field with no default.
   */
  it("refuses an own document key that is explicitly undefined", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: {
            id: { type: "string", id: true },
            probe: { type: "string", default: undefined },
          },
        },
      },
    });
    expect(issues(error)).toEqual(["[J004] /models/user/fields/probe/default"]);
  });

  /**
   * And it is ONE rule, not a rule about defaults: the key walk every node
   * passes through decides it, so an own `undefined` is refused wherever the
   * document has an optional key — and a data-keyed entry (`models`, `fields`,
   * `enums`) is refused by the node reader that finds no record there.
   */
  it.each([
    [
      "a top-level optional key",
      { version: 1, models: {}, enums: undefined },
      "/enums",
    ],
    [
      "a model entry",
      { version: 1, models: { user: undefined } },
      "/models/user",
    ],
    [
      "a model's optional key",
      { version: 1, models: { user: { fields: ID_ONLY, table: undefined } } },
      "/models/user/table",
    ],
    [
      "an index's optional key",
      {
        version: 1,
        models: {
          user: {
            fields: ID_ONLY,
            indexes: [{ fields: ["id"], name: undefined }],
          },
        },
      },
      "/models/user/indexes/0/name",
    ],
    [
      "a relation's optional key",
      {
        version: 1,
        models: {
          user: {
            fields: {
              ...ID_ONLY,
              posts: { type: "toMany", target: "user", name: undefined },
            },
          },
        },
      },
      "/models/user/fields/posts/name",
    ],
  ])("refuses %s that is explicitly undefined", (_label, document, path) => {
    expect(issues(refusal(document))).toEqual([`[J004] ${path}`]);
  });
});

function serializedDefault(field: object): unknown {
  const schema = parseSchema(withUserField(field));
  return schema.user?.["~"].state.scalars.probe?.["~"].state.default;
}

/**
 * A node whose SHAPE is wrong at every level. Each case leaves the node out of
 * the document — the walk keeps going and reports the rest — which is what makes
 * one throw carry an author's whole artifact.
 */
describe("malformed nodes", () => {
  const cases: [string, object, string][] = [
    [
      "`enums` is not an object",
      { version: 1, models: {}, enums: [] },
      "/enums",
    ],
    [
      "an enum definition is not an object",
      { version: 1, models: {}, enums: { a: 1 } },
      "/enums/a",
    ],
    [
      "`values` is missing",
      { version: 1, models: {}, enums: { a: {} } },
      "/enums/a/values",
    ],
    [
      "`values` holds a non-string",
      { version: 1, models: {}, enums: { a: { values: ["x", 2] } } },
      "/enums/a/values/1",
    ],
    [
      "an enum `name` is not a string",
      { version: 1, models: {}, enums: { a: { values: ["x"], name: 7 } } },
      "/enums/a/name",
    ],
    ["`models` is missing", { version: 1 }, "/models"],
    [
      "a model is not an object",
      { version: 1, models: { user: 1 } },
      "/models/user",
    ],
    [
      "`fields` is missing",
      { version: 1, models: { user: {} } },
      "/models/user/fields",
    ],
    [
      "a field is not an object",
      { version: 1, models: { user: { fields: { id: 1 } } } },
      "/models/user/fields/id",
    ],
    [
      "`table` is not a string",
      { version: 1, models: { user: { fields: {}, table: 1 } } },
      "/models/user/table",
    ],
    [
      "`omit` is not an array",
      { version: 1, models: { user: { fields: {}, omit: "id" } } },
      "/models/user/omit",
    ],
    [
      "`indexes` is not an array",
      { version: 1, models: { user: { fields: {}, indexes: {} } } },
      "/models/user/indexes",
    ],
    [
      "an index is not an object",
      { version: 1, models: { user: { fields: {}, indexes: [1] } } },
      "/models/user/indexes/0",
    ],
    [
      "an index has no `fields`",
      { version: 1, models: { user: { fields: {}, indexes: [{}] } } },
      "/models/user/indexes/0/fields",
    ],
    [
      "an index `name` is not a string",
      {
        version: 1,
        models: { user: { fields: {}, indexes: [{ fields: [], name: 1 }] } },
      },
      "/models/user/indexes/0/name",
    ],
    [
      "an index `unique` is not a boolean",
      {
        version: 1,
        models: { user: { fields: {}, indexes: [{ fields: [], unique: 1 }] } },
      },
      "/models/user/indexes/0/unique",
    ],
    [
      "`ids` is not an array",
      { version: 1, models: { user: { fields: {}, ids: {} } } },
      "/models/user/ids",
    ],
    [
      "a compound key is not an object",
      { version: 1, models: { user: { fields: {}, uniques: [1] } } },
      "/models/user/uniques/0",
    ],
    [
      "a compound key has no `fields`",
      { version: 1, models: { user: { fields: {}, uniques: [{}] } } },
      "/models/user/uniques/0/fields",
    ],
    [
      "a compound `name` is not a string",
      {
        version: 1,
        models: { user: { fields: {}, ids: [{ fields: [], name: 1 }] } },
      },
      "/models/user/ids/0/name",
    ],
  ];
  it.each(cases)("refuses when %s", (_title, document, path) => {
    expect(refusal(document).issues.map((issue) => issue.path)).toContain(path);
  });

  const fieldCases: [string, object, string][] = [
    ["`column` is not a string", { type: "string", column: 1 }, "column"],
    [
      "`dimension` is not a number",
      { type: "vector", dimension: "3" },
      "dimension",
    ],
    ["`native` is not an object", { type: "string", native: "pg" }, "native"],
    [
      "`native.type` is missing",
      { type: "string", native: { db: "pg" } },
      "native/type",
    ],
    [
      "`generate` is not an object",
      { type: "string", generate: "ulid" },
      "generate",
    ],
    [
      "`generate.prefix` is not a string",
      { type: "string", generate: { kind: "ulid", prefix: 1 } },
      "generate/prefix",
    ],
    [
      "`generate.length` is not a number",
      { type: "string", generate: { kind: "nanoid", length: "8" } },
      "generate/length",
    ],
    ["an inline `enum` is not an array", { type: "enum", enum: 1 }, "enum"],
    ["`target` is not a string", { type: "toOne", target: 1 }, "target"],
    ["`variants` is not an object", { type: "toOne", variants: 1 }, "variants"],
    [
      "a variant target is not a string",
      { type: "toOne", variants: { a: 1 } },
      "variants/a",
    ],
    [
      "`values` is not an object",
      { type: "toOne", variants: { a: "user" }, values: 1 },
      "values",
    ],
    [
      "a stored value is not a string",
      { type: "toOne", variants: { a: "user" }, values: { a: 1 } },
      "values/a",
    ],
    [
      "`fields` is not an array of strings",
      { type: "toOne", target: "user", fields: [1] },
      "fields/0",
    ],
    [
      "`references` is not an array",
      { type: "toOne", target: "user", references: "id" },
      "references",
    ],
    [
      "`junction` is not an object",
      { type: "toMany", target: "user", junction: 1 },
      "junction",
    ],
    [
      "a junction token is not a string",
      { type: "toMany", target: "user", junction: { table: 1 } },
      "junction/table",
    ],
    [
      "`through` is not an object",
      { type: "toMany", variants: { a: "user" }, through: 1 },
      "through",
    ],
    [
      "a member junction is not an object",
      { type: "toMany", variants: { a: "user" }, through: { a: 1 } },
      "through/a",
    ],
    [
      "a member junction is missing a key",
      {
        type: "toMany",
        variants: { a: "user" },
        through: { a: { table: "t", source: "s" } },
      },
      "through/a/target",
    ],
    [
      "`optional` is not a boolean",
      { type: "toOne", variants: { a: "user" }, optional: 1 },
      "optional",
    ],
  ];
  it.each(fieldCases)("refuses when a field's %s", (_title, field, suffix) => {
    expect(
      refusal(withUserField(field)).issues.map((issue) => issue.path)
    ).toContain(`/models/user/fields/probe/${suffix}`);
  });
});

describe("indexes", () => {
  /**
   * `where` is the declaration surface's one raw-SQL string, interpolated
   * unescaped into DDL. A machine-written document must not carry an execution
   * channel, so it is refused BY NAME rather than as an unknown key.
   */
  it("refuses `indexes[].where`", () => {
    const error = refusal({
      version: 1,
      models: {
        user: {
          fields: { id: { type: "string", id: true } },
          indexes: [{ fields: ["id"], where: "id > 0" }],
        },
      },
    });
    expect(issues(error)).toEqual(["[J009] /models/user/indexes/0/where"]);
    expect(error.issues[0]?.message).toContain("raw SQL");
  });
});

/**
 * The boundary's totality. A document handed in as an OBJECT is executable —
 * every read can run code, and every value can be shaped to defeat a walk — so
 * the one thing this family proves is that nothing a caller writes escapes as
 * itself: a raw throw, a `RangeError` from an unbounded walk, or a stack.
 */
describe("hostile reads", () => {
  it("owns the refusal when an array element accessor throws", () => {
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "array element";
      },
    });
    Object.defineProperty(hostile, "length", { value: 1 });
    const error = refusal({
      version: 1,
      models: { user: { fields: {}, omit: hostile } },
    });
    expect(issues(error)).toEqual(["[J004] /models/user/omit/0"]);
  });

  it("owns the refusal when an index element accessor throws", () => {
    const hostile: unknown[] = [];
    Object.defineProperty(hostile, "0", {
      enumerable: true,
      get() {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "index element";
      },
    });
    Object.defineProperty(hostile, "length", { value: 1 });
    const error = refusal({
      version: 1,
      models: { user: { fields: {}, indexes: hostile } },
    });
    expect(issues(error)).toEqual(["[J004] /models/user/indexes/0"]);
  });

  // A default is the one node whose depth the format does not bound, so it is
  // the one walk a caller-built object can make non-terminating.
  it("refuses a cyclic default instead of exhausting the stack", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const error = refusal(
      withUserField({ type: "json", default: { seed: cyclic } })
    );
    expect(issues(error)).toEqual([
      "[J004] /models/user/fields/probe/default/seed/self",
    ]);
    expect(error.issues[0]?.message).toContain("cycle");
  });

  it("refuses a self-referencing array default", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(
      issues(refusal(withUserField({ type: "json", default: cyclic })))
    ).toEqual(["[J004] /models/user/fields/probe/default/0"]);
  });

  /**
   * A throwing accessor is not just a location: what it threw is the only
   * account of WHY, so it survives as the refusal's cause. The error framework
   * redacts the cause's own message, which is why the witness is its presence —
   * dropping it entirely is what left a reader with a pointer and nothing else.
   */
  it("keeps what a throwing accessor threw as the cause", () => {
    const error = refusal({
      version: 1,
      models: {
        get user(): unknown {
          throw new Error("accessor boom");
        },
      },
    });
    expect(issues(error)).toEqual(["[J004] /models/user"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("normalizes a non-Error accessor throw into the cause", () => {
    const error = refusal({
      version: 1,
      models: {
        get user(): unknown {
          // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
          throw "just a string";
        },
      },
    });
    expect(issues(error)).toEqual(["[J004] /models/user"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("survives a thrown value whose own string conversion throws", () => {
    const unspeakable = {
      toString() {
        throw new Error("toString threw");
      },
    };
    const error = refusal({
      version: 1,
      models: {
        get user(): unknown {
          throw unspeakable;
        },
      },
    });
    expect(issues(error)).toEqual(["[J004] /models/user"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  /**
   * `version` is a caller value rendered INTO a message, so it is rendered by
   * the boundary's own safe renderer rather than `JSON.stringify`, which throws
   * on a `bigint`. `1n` is not the number `1`, so it is an unsupported version —
   * named, not a raw `TypeError`.
   */
  it("renders a bigint version rather than throwing a TypeError", () => {
    const error = refusal({ version: 1n, models: {} });
    expect(issues(error)).toEqual(["[J002] /version"]);
    expect(error.issues[0]?.message).toContain("version 1");
  });

  // A value whose own `toString` throws is never coerced by the renderer.
  it("renders a version whose toString throws without invoking it", () => {
    const hostile = {
      toString() {
        throw new Error("version toString");
      },
    };
    const error = refusal({ version: hostile, models: {} });
    expect(issues(error)).toEqual(["[J002] /version"]);
  });

  // Prototype inspection is executable input too: a proxy can trap it.
  it("owns the refusal when a getPrototypeOf trap throws", () => {
    const hostile = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("prototype trap");
        },
      }
    );
    const error = refusal({ version: 1, models: { user: hostile } });
    expect(issues(error)).toEqual(["[J004] /models/user"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  // Own-key enumeration is executable input too: a proxy can trap it.
  it("owns the refusal when an ownKeys trap throws", () => {
    const hostile = new Proxy(
      { id: { type: "string" } },
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      }
    );
    const error = refusal({
      version: 1,
      models: { user: { fields: hostile } },
    });
    expect(issues(error)).toEqual(["[J004] /models/user/fields"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });
});

/**
 * `native.type` is the one document string that reaches DDL verbatim: the three
 * migration drivers emit `nativeType.type` as the column type with no escaping
 * of any kind, because a coded schema's native type comes from a typed constant.
 * A DOCUMENT is untrusted, so the dialect's closed catalog is what stands
 * between an author's artifact and the statement a driver runs.
 */
describe("native types", () => {
  function withNative(type: unknown) {
    return withUserField({ type: "string", native: { db: "pg", type } });
  }

  it("refuses a native type carrying a statement break", () => {
    const error = refusal(withNative("TEXT); DROP TABLE victims; --"));
    expect(issues(error)).toEqual([
      "[J011] /models/user/fields/probe/native/type",
    ]);
    // The message names the dialect whose catalog was consulted (`withNative`
    // declares `pg`) and points at the docs.
    expect(error.issues[0]?.message).toContain("pg");
  });

  it.each([
    ["a quote", "TEXT'"],
    ["a double quote", 'TEXT"'],
    ["a semicolon", "TEXT; SELECT 1"],
    ["a comment", "TEXT -- x"],
    ["a newline", "TEXT\nDROP TABLE t"],
    ["a second parenthesized group", "varchar(1)(2)"],
    ["an unbalanced parenthesis", "varchar(1"],
    ["nothing at all", ""],
    ["a leading digit", "1varchar"],
    ["a backslash", "TEXT\\"],
  ])("refuses a native type carrying %s", (_label, type) => {
    expect(issues(refusal(withNative(type)))).toEqual([
      "[J011] /models/user/fields/probe/native/type",
    ]);
  });

  /**
   * The round-1 word grammar accepted these three: each is letters and spaces
   * with an optional parenthesized group, which no regex can tell apart from a
   * multi-word type name. They ALTER physical schema semantics — a foreign key,
   * a unique constraint, a check — appended to a column's type in DDL. The
   * closed sqlite catalog is `{TEXT, INTEGER, REAL, NUMERIC, BLOB}`; none of the
   * three is a member, so the catalog refuses all three by name.
   */
  it.each([
    ["a foreign-key clause", "TEXT REFERENCES victims(id)"],
    ["a unique clause", "TEXT UNIQUE"],
    ["a check clause", "TEXT CHECK(0)"],
  ])("refuses a sqlite native type carrying %s", (_label, type) => {
    expect(
      issues(
        refusal(
          withUserField({ type: "string", native: { db: "sqlite", type } })
        )
      )
    ).toEqual(["[J011] /models/user/fields/probe/native/type"]);
  });

  /**
   * The property that makes the catalog an ANSWER to the injection rather than a
   * patch over three known spellings: no word a constraint clause is built from
   * is a member of any dialect's catalog, in either case. So there is nothing to
   * append a clause WITH — not just no `TEXT UNIQUE`, but no `UNIQUE` either,
   * and no way to reach one by a spelling the three probes did not try.
   */
  it.each([
    "references",
    "unique",
    "check",
    "primary",
    "key",
    "not",
    "null",
    "default",
    "constraint",
    "foreign",
    "on",
    "collate",
    "generated",
    "as",
    "always",
    "stored",
  ])("admits no dialect's catalog the constraint word '%s'", (word) => {
    for (const db of ["pg", "mysql", "sqlite"] as const) {
      for (const type of [word, word.toUpperCase()]) {
        expect(
          issues(
            refusal(withUserField({ type: "string", native: { db, type } }))
          )
        ).toEqual(["[J011] /models/user/fields/probe/native/type"]);
      }
    }
  });

  /**
   * A value only belongs to the catalog of its DECLARED dialect. `TEXT` is a
   * mysql/sqlite constant, spelled lower-case (`text`) in pg; `INTEGER` is a
   * pg/sqlite constant absent from mysql. The dialect names the catalog.
   */
  it("matches a native type against the declared dialect's catalog only", () => {
    // `TEXT` upper-case is a mysql/sqlite constant, not a pg one (pg has `text`).
    expect(
      issues(
        refusal(
          withUserField({ type: "string", native: { db: "pg", type: "TEXT" } })
        )
      )
    ).toEqual(["[J011] /models/user/fields/probe/native/type"]);
    // ...and it passes for the dialect that does declare it.
    expect(() =>
      parseSchema(
        withUserField({ type: "string", native: { db: "mysql", type: "TEXT" } })
      )
    ).not.toThrow();
  });

  /**
   * The catalog's own falsifier: every value the three shipped constant trees
   * can produce must pass, or the gate would refuse documents the builders
   * themselves write. Functions are called at each arity they publish; a
   * required-argument function called with too few produces a string carrying
   * `undefined` — never a value the constant yields — so those are skipped. Each
   * produced value is matched against the catalog of ITS OWN dialect.
   */
  it("accepts every native type the shipped dialect constants produce", () => {
    const produced: NativeType[] = [];
    const artifacts: NativeType[] = [];
    const asNativeType = (value: unknown): NativeType | undefined => {
      if (value === null || typeof value !== "object") return;
      const db: unknown = Reflect.get(value, "db");
      const type: unknown = Reflect.get(value, "type");
      if (typeof type !== "string") return;
      if (db === "pg" || db === "mysql" || db === "sqlite") return { db, type };
      return;
    };
    const collect = (node: unknown): void => {
      if (typeof node === "function") {
        for (const args of [[], [10], [10, 2]]) {
          const native = asNativeType(node.call(undefined, ...args));
          if (native === undefined) continue;
          (native.type.includes("undefined") ? artifacts : produced).push(
            native
          );
        }
        return;
      }
      if (node === null || typeof node !== "object") return;
      const leaf = asNativeType(node);
      if (leaf !== undefined) {
        produced.push(leaf);
        return;
      }
      for (const value of Object.values(node)) collect(value);
    };
    collect(PG);
    collect(MYSQL);
    collect(SQLITE);
    // ENUMERATED, not bounded: the catalog is derived from these trees, so the
    // census is the proof's subject and a tripwire on it. Growing the trees is
    // expected — re-run this test, read the new counts off its failure, and
    // update them, which is the moment to notice a new value reaching DDL.
    expect(produced).toHaveLength(115);
    expect(new Set(produced.map((n) => `${n.db} ${n.type}`))).toHaveProperty(
      "size",
      91
    );

    for (const native of produced) {
      expect(() =>
        parseSchema(withUserField({ type: "string", native }))
      ).not.toThrow();
    }

    // The derivation's own artifacts are NOT catalog members: calling a
    // required-argument function with none produces `varchar(undefined)`, which
    // no constant yields and the catalog must not have learned from probing.
    expect(artifacts.map((n) => n.type)).toEqual([
      "varchar(undefined)",
      "char(undefined)",
      "bit(undefined)",
      "VARCHAR(undefined)",
      "CHAR(undefined)",
      "BIT(undefined)",
      "BINARY(undefined)",
      "VARBINARY(undefined)",
    ]);
    for (const native of artifacts) {
      expect(
        issues(refusal(withUserField({ type: "string", native })))
      ).toEqual(["[J011] /models/user/fields/probe/native/type"]);
    }
  });
});

/**
 * The options argument is the CALL's shape, not the document's, so its pointers
 * name `/options` — a segment no document node has. It is read hostilely for one
 * reason: a misspelled `validate` is a call that asked for the schema validator
 * and silently did not get it.
 */
describe("options", () => {
  /** Options as a program actually builds them — from data, not from a literal. */
  function fromData(raw: unknown): SchemaJsonOptions {
    return JSON.parse(JSON.stringify(raw));
  }

  function optionRefusal(options: SchemaJsonOptions): ValidationError {
    try {
      parseSchema(MINIMAL, options);
    } catch (thrown) {
      if (thrown instanceof ValidationError) return thrown;
      throw thrown;
    }
    throw new Error("parseSchema accepted options it must refuse");
  }

  it("refuses an unknown option beside the real one", () => {
    const error = optionRefusal(fromData({ validate: true, validat: true }));
    expect(issues(error)).toEqual(["[J003] /options/validat"]);
    expect(error.issues[0]?.message).toContain("'validate'");
  });

  it("refuses an unknown option that stands alone", () => {
    expect(issues(optionRefusal(fromData({ validat: true })))).toEqual([
      "[J003] /options/validat",
    ]);
  });

  it("refuses a `validate` that is not a boolean", () => {
    expect(issues(optionRefusal(fromData({ validate: "true" })))).toEqual([
      "[J004] /options/validate",
    ]);
  });

  it("refuses an options argument that is not a plain object", () => {
    expect(issues(optionRefusal(fromData(null)))).toEqual(["[J004] /options"]);
    expect(issues(optionRefusal(fromData(["validate"])))).toEqual([
      "[J004] /options",
    ]);
  });

  it("refuses the call before the document, in both directions", () => {
    const badOptions = fromData({ validat: true });
    // A document that is ALSO wrong is not even read: the call is malformed.
    expect(() => parseSchema({ version: 2 }, badOptions)).toThrow(
      UNKNOWN_OPTION
    );
    expect(() => serializeSchema({}, badOptions)).toThrow(UNKNOWN_OPTION);
  });

  /**
   * The options bag is caller-controlled too — a program that builds it from
   * data can build it from a getter — so it is read through the same guarded
   * accessor the document gets, under its own pointer root.
   */
  it("owns the refusal when an option accessor throws", () => {
    const hostile: SchemaJsonOptions = {
      get validate(): boolean {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "option accessor";
      },
    };
    expect(issues(optionRefusal(hostile))).toEqual([
      "[J004] /options/validate",
    ]);
    let refused: unknown;
    try {
      serializeSchema({}, hostile);
    } catch (thrown) {
      refused = thrown;
    }
    expect(refused).toBeInstanceOf(ValidationError);
  });

  it("accepts an empty options bag and an explicit `false`", () => {
    expect(Object.keys(parseSchema(MINIMAL, fromData({})))).toEqual(["user"]);
    expect(Object.keys(parseSchema(MINIMAL, { validate: false }))).toEqual([
      "user",
    ]);
  });

  /**
   * The DOCUMENT refuses an own `undefined` (a document states absence by
   * omission). The OPTIONS bag keeps TOLERATING it: `validate?: boolean` admits
   * `undefined` by the TS optional-property idiom, and refusing what the type
   * allows would fight the language. The two split deliberately.
   */
  it("tolerates `validate` explicitly undefined in the options bag", () => {
    expect(Object.keys(parseSchema(MINIMAL, { validate: undefined }))).toEqual([
      "user",
    ]);
  });
});
