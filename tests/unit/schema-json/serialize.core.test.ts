/**
 * The serializer's refusals, and the two properties that make it safe to point
 * at a schema you do not own.
 *
 * A fact the format cannot carry is named LOUDLY. A silent drop would produce a
 * document that parses into a DIFFERENT schema, which is the one failure a
 * round trip must not have.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import type { Schema } from "@schema/hydration";
import { hydrateSchemaNames } from "@schema/hydration";
import { attachFieldSchemas, parseSchema, serializeSchema } from "@schema/json";
import { SchemaValidationError } from "@schema/validation/error";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type { JsonValue } from "@validation";
import { describe, expect, it } from "vitest";
import { z } from "zod";

function refusal(schema: Schema): ValidationError {
  try {
    serializeSchema(schema);
  } catch (thrown) {
    if (thrown instanceof ValidationError) return thrown;
    throw thrown;
  }
  throw new Error("serializeSchema accepted a schema it must refuse");
}

const MINIMAL = {
  version: 1,
  models: { user: { fields: { id: { type: "string", id: true } } } },
};

function issues(error: ValidationError): string[] {
  return error.issues.map(
    (issue) => `${issue.message.slice(0, 6)} ${issue.path}`
  );
}

/** Caller-written defaults, one per temporal shape the generators cover. */
const overrideString = () => "overridden";
const overrideDate = () => "2020-01-02T03:04:05.000Z";
const overrideDay = () => "2020-01-02";
const overrideClock = () => "03:04:05";

describe("refusal witnesses", () => {
  it("names a hostile fixed-decimal native override", () => {
    const amount = s.decimal({ precision: 10, scale: 2 });
    const ledger = s.model({ id: s.string().id(), amount });
    ledger["~"].state.scalars.amount = new Proxy(amount, {
      get(target, property, receiver) {
        if (property === "~") {
          return {
            state: target["~"].state,
            nativeType: { db: "postgresql", type: "numeric" },
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const error = refusal({ ledger });
    expect(issues(error)).toEqual([
      "[J009] /models/ledger/fields/amount/native",
    ]);
  });

  it("names the field carrying a function default", () => {
    const user = s.model({
      id: s.string().id(),
      createdAt: s.dateTime().default(() => new Date()),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual([
      "[J009] /models/user/fields/createdAt/default",
    ]);
    expect(error.issues[0]?.message).toContain("`generate`");
  });

  /**
   * A generator writes BOTH `autoGenerate` and a default closure, so "there is
   * a generator" was never evidence that the closure standing there is the
   * generator's. `.uuid().default(() => "fixed")` leaves the uuid declaration
   * in state and the caller's function in `default` — a document that emitted
   * `generate` and dropped the function would state a field that produces
   * random values where the original produced one.
   */
  it("names the field whose function default is not the generator's own", () => {
    const user = s.model({
      id: s.string().id(),
      token: s
        .string()
        .uuid()
        .default(() => "fixed"),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual(["[J009] /models/user/fields/token/default"]);
    expect(error.issues[0]?.message).toContain("`generate`");
  });

  it("names an overridden generator default on every generator kind", () => {
    const overridden = [
      s.string().uuid().default(overrideString),
      s.string().ulid().default(overrideString),
      s.string().nanoid().default(overrideString),
      s.string().cuid().default(overrideString),
      s.string().id().default(overrideString),
      s.dateTime().now().default(overrideDate),
      s.dateTime().updatedAt().default(overrideDate),
      s.date().now().default(overrideDay),
      s.time().updatedAt().default(overrideClock),
    ];
    for (const probe of overridden) {
      const user = s.model({ id: s.string().id(), probe });
      expect(issues(refusal({ user }))).toEqual([
        "[J009] /models/user/fields/probe/default",
      ]);
    }
  });

  /**
   * The other half of the same rule: a generator's OWN closure is the
   * declaration `generate` already states, so it is omitted rather than
   * refused.
   */
  it("still writes `generate` for every generator the builders install", () => {
    const user = s.model({
      id: s.string().id("u"),
      uid: s.string().uuid(),
      ulid: s.string().ulid("p"),
      nano: s.string().nanoid(8),
      cuid: s.string().cuid(),
      seq: s.int().increment(),
      big: s.bigInt().increment(),
      at: s.dateTime().now(),
      touched: s.dateTime().updatedAt(),
      day: s.date().now(),
      clock: s.time().updatedAt(),
    });
    const fields = serializeSchema({ user }).models.user?.fields ?? {};
    expect(
      Object.entries(fields).map(([key, field]) =>
        "generate" in field ? [key, field.generate?.kind] : [key, "none"]
      )
    ).toEqual([
      ["id", "ulid"],
      ["uid", "uuid"],
      ["ulid", "ulid"],
      ["nano", "nanoid"],
      ["cuid", "cuid"],
      ["seq", "increment"],
      ["big", "increment"],
      ["at", "now"],
      ["touched", "updatedAt"],
      ["day", "now"],
      ["clock", "updatedAt"],
    ]);
    for (const field of Object.values(fields)) {
      expect("default" in field ? field.default : undefined).toBeUndefined();
    }
  });

  it("names the field carrying a custom `.schema()` validator", () => {
    const user = s.model({
      id: s.string().id(),
      email: s.string().schema(z.string().email()),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual(["[J009] /models/user/fields/email"]);
    expect(error.issues[0]?.message).toContain("attachFieldSchemas");
  });

  it("names the index carrying a `where` predicate", () => {
    const user = s
      .model({ id: s.string().id(), age: s.int() })
      .index(["age"], { where: "age > 0" });
    const error = refusal({ user });
    expect(issues(error)).toEqual(["[J009] /models/user/indexes/0"]);
    expect(error.issues[0]?.message).toContain("raw SQL");
  });

  it("names one enum type declared with two different value sets", () => {
    const user = s.model({
      id: s.string().id(),
      a: s.enum(["x", "y"]).name("st"),
      b: s.enum(["x", "z"]).name("st"),
    });
    expect(issues(refusal({ user }))).toEqual(["[J009] /models/user/fields/b"]);
  });

  /**
   * The document is the untrusted artifact, so the catalog gate lives at the
   * parse boundary — but a document the serializer writes and the parser then
   * refuses would be a round trip that silently loses a schema. The serializer
   * refuses the same value by the same rule, so the document never carries what
   * parse would not take back.
   */
  it("names the field whose native type is outside its dialect's catalog", () => {
    const user = s.model({
      id: s.string().id(),
      sneaky: s.string({ db: "pg", type: "TEXT); DROP TABLE victims; --" }),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual([
      "[J011] /models/user/fields/sneaky/native/type",
    ]);
    expect(error.issues[0]?.message).toContain("pg");
  });

  /**
   * The document is a value the caller owns and edits; the scalar's own native
   * object is not. The serializer copies `{ db, type }` into the document, so
   * editing the document cannot reach declaration state.
   */
  it("copies the native declaration rather than aliasing scalar state", () => {
    const scalar = s.string({ db: "pg", type: "varchar(255)" });
    const user = s.model({ id: s.string().id(), slug: scalar });
    const document = serializeSchema({ user });
    const field = document.models.user?.fields.slug;
    if (
      field === undefined ||
      !("native" in field) ||
      field.native === undefined
    ) {
      throw new Error("the slug field carries a native declaration");
    }
    Object.assign(field.native, { type: "text" });
    expect(scalar["~"].nativeType?.type).toBe("varchar(255)");
  });

  /**
   * A json default is a value the caller owns, and reading it is executable
   * input: a throwing accessor becomes the serializer's own refusal, cause
   * preserved, never a raw escape from `serializeSchema`.
   */
  it("names the field whose coded default has a throwing accessor", () => {
    // A json default the API accepts by type — the hostile part is the
    // ACCESSOR, which no type can describe and only a guarded read survives.
    const hostile: Record<string, JsonValue> = {};
    Object.defineProperty(hostile, "boom", {
      enumerable: true,
      get() {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "default accessor";
      },
    });
    const user = s.model({
      id: s.string().id(),
      data: s.json().default(hostile),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual([
      "[J009] /models/user/fields/data/default/boom",
    ]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("collects every refusal in the schema and throws once", () => {
    const user = s
      .model({
        id: s.string().id(),
        age: s.int(),
        createdAt: s.dateTime().default(() => new Date()),
        email: s.string().schema(z.string()),
      })
      .index(["age"], { where: "age > 0" });
    expect(issues(refusal({ user }))).toEqual([
      "[J009] /models/user/fields/createdAt/default",
      "[J009] /models/user/fields/email",
      "[J009] /models/user/indexes/0",
    ]);
  });

  /**
   * A target getter is the one part of a declaration that runs code. Serializing
   * invokes it, so a getter that throws is reported rather than handed back as a
   * half-written document.
   */
  it("names a relation whose target getter throws", () => {
    const user = s.model({
      id: s.string().id(),
      broken: s.toOne(() => {
        throw new Error("the target model is not defined yet");
      }),
    });
    const error = refusal({ user });
    expect(issues(error)).toEqual(["[J006] /models/user/fields/broken"]);
    expect(error.originalCause).toBeInstanceOf(Error);
  });

  it("names a relation whose target is outside the record being serialized", () => {
    const outsider = s.model({ id: s.string().id() });
    const user = s.model({
      id: s.string().id(),
      strays: s.toMany(() => outsider),
    });
    expect(issues(refusal({ user }))).toEqual([
      "[J006] /models/user/fields/strays",
    ]);
  });
});

/**
 * A document-local `enums` key and a database enum type name are two different
 * things that happened to be spelled the same.
 *
 * The ref key addresses a definition WITHIN one document, so it is an
 * identifier (`J005`); the DB name is whatever the database allows, which
 * includes hyphens, and whatever a caller passed, which includes `__proto__`.
 * Conflating them made the serializer write documents its own parser rejects,
 * and crash outright on the name that is a property of every object.
 */
describe("enum reference keys", () => {
  function enumsOf(schema: Schema) {
    return serializeSchema(schema).enums ?? {};
  }

  it("keeps a DB name that is not an identifier out of the ref key", () => {
    const user = s.model({
      id: s.string().id(),
      status: s.enum(["a", "b"]).name("status-v2"),
    });
    const document = serializeSchema({ user });
    expect(Object.values(document.enums ?? {})).toEqual([
      { values: ["a", "b"], name: "status-v2" },
    ]);
    expect(serializeSchema(parseSchema(document))).toEqual(document);
    expect(
      parseSchema(document).user?.["~"].state.scalars.status?.["~"].state
        .enumName
    ).toBe("status-v2");
  });

  it("serializes a DB name that is a prototype property, and reads it back", () => {
    const user = s.model({
      id: s.string().id(),
      status: s.enum(["a", "b"]).name("__proto__"),
    });
    const document = serializeSchema({ user });
    expect(Object.values(document.enums ?? {})).toEqual([
      { values: ["a", "b"], name: "__proto__" },
    ]);
    expect(serializeSchema(parseSchema(document))).toEqual(document);
  });

  it("keeps two DB names apart even when one collides with a derived key", () => {
    const user = s.model({
      id: s.string().id(),
      first: s.enum(["a"]).name("needs-a-key"),
      second: s.enum(["b"]).name("enum_1"),
    });
    const document = serializeSchema({ user });
    expect(document.enums).toEqual({
      enum_1: { values: ["a"], name: "needs-a-key" },
      enum_2: { values: ["b"], name: "enum_1" },
    });
    expect(serializeSchema(parseSchema(document))).toEqual(document);
  });

  it("walks past a derived key an earlier DB name already took", () => {
    const user = s.model({
      id: s.string().id(),
      first: s.enum(["a"]).name("enum_2"),
      second: s.enum(["b"]).name("also-not-an-identifier"),
    });
    const document = serializeSchema({ user });
    expect(document.enums).toEqual({
      enum_2: { values: ["a"], name: "enum_2" },
      enum_3: { values: ["b"], name: "also-not-an-identifier" },
    });
    expect(serializeSchema(parseSchema(document))).toEqual(document);
  });

  it("shares one ref for every field naming one DB enum type", () => {
    const user = s.model({
      id: s.string().id(),
      a: s.enum(["x", "y"]).name("st-1"),
      b: s.enum(["x", "y"]).name("st-1"),
    });
    expect(Object.keys(enumsOf({ user }))).toHaveLength(1);
    const fields = serializeSchema({ user }).models.user?.fields ?? {};
    expect(fields.a).toEqual(fields.b);
  });

  it("still refuses one non-identifier DB name with two value sets", () => {
    const user = s.model({
      id: s.string().id(),
      a: s.enum(["x", "y"]).name("st-1"),
      b: s.enum(["x", "z"]).name("st-1"),
    });
    expect(issues(refusal({ user }))).toEqual(["[J009] /models/user/fields/b"]);
  });

  /**
   * Value sets are compared ELEMENT-WISE, never as one joined string.
   * `["a b", "c"]` and `["a", "b c"]` both join to `"a b c"`, so a joined
   * comparison would call them equal and let the second silently inherit the
   * first's values — one database enum type quietly holding the wrong set.
   */
  it("distinguishes value sets a space-join would collapse", () => {
    const user = s.model({
      id: s.string().id(),
      a: s.enum(["a b", "c"]).name("st"),
      b: s.enum(["a", "b c"]).name("st"),
    });
    expect(issues(refusal({ user }))).toEqual(["[J009] /models/user/fields/b"]);
  });

  /**
   * Every record the serializer keys by DATA is built key by key. A model or a
   * field named `__proto__` would otherwise set a prototype and create no entry
   * — a document silently missing a declaration, which no later check notices
   * because what is left is a well-formed document.
   */
  it("keys models by data without setting a prototype", () => {
    const schema: Schema = Object.create(null);
    Object.defineProperty(schema, "__proto__", {
      value: s.model({ id: s.string().id() }),
      enumerable: true,
    });
    const models = serializeSchema(schema).models;
    expect(Object.keys(models)).toEqual(["__proto__"]);
    expect(Object.getOwnPropertyDescriptor(models, "__proto__")?.value).toEqual(
      {
        fields: {
          id: { type: "string", id: true, generate: { kind: "ulid" } },
        },
      }
    );
  });

  /**
   * `fields`, `variants`, `values` and `through` are built the same way. They
   * have no witness of their own because a field or variant key that is a
   * prototype property cannot reach this serializer today: `s.model()` drops
   * such a member from `state.scalars` before the document is written, and the
   * relation factories refuse a variant key that is not an identifier. The
   * construction is uniform anyway — a serializer that built ONE of its maps by
   * assignment would be a map whose safety depended on an upstream accident.
   */
  it("builds every document-keyed record without a prototype", () => {
    const document = serializeSchema({
      user: s.model({ id: s.string().id(), status: s.enum(["a"]).name("st") }),
    });
    for (const record of [
      document.models,
      document.enums,
      document.models.user?.fields,
    ]) {
      expect(Object.getPrototypeOf(record ?? {})).toBe(null);
    }
  });
});

describe("non-mutating", () => {
  /**
   * Hydration write-once-binds a model to a schema key (`M003`). A serializer
   * that hydrated would foreclose ever binding those models under other keys,
   * so a dump-for-diagnosis would silently consume the schema.
   */
  it("leaves the schema unbound, so other keys stay available", () => {
    const account = s.model({ id: s.string().id() });
    serializeSchema({ account });
    expect(account["~"].names.ts).toBeUndefined();
    hydrateSchemaNames({ renamed: account });
    expect(account["~"].names.ts).toBe("renamed");
  });

  /**
   * `settleTarget` is a once-cell every later consumer inherits. Serializing
   * invokes the getter DIRECTLY so a diagnostic dump never decides it.
   */
  it("leaves every relation target unsettled", () => {
    let target = s.model({ id: s.string().id() });
    const holder = s.model({
      id: s.string().id(),
      slot: s.toMany(() => target),
    });
    serializeSchema({ holder, target });
    const replacement = s.model({ id: s.string().id() });
    target = replacement;
    expect(holder["~"].state.relations.slot?.["~"].settleTarget()).toBe(
      replacement
    );
  });

  it("dumps a schema the resolution gate refuses", () => {
    // Two `toOne` slots naming the same pair with no foreign key anywhere: a
    // topology the gate rejects, and a declaration the document still states.
    const left = s.model({ id: s.string().id(), right: s.toOne(() => right) });
    const right = s.model({ id: s.string().id(), left: s.toOne(() => left) });
    const document = serializeSchema({ left, right });
    expect(document.models.left?.fields.right).toEqual({
      type: "toOne",
      target: "right",
    });
    expect(() => hydrateSchemaNames({ left, right })).not.toThrow();
  });
});

/**
 * `{ validate: true }` trades the guarantee above for a louder failure, and the
 * trade is the whole point of the option being off by default: refusing garbage
 * before emitting it means running the validator, and the validator writes.
 */
describe("serializeSchema({ validate: true })", () => {
  /** A schema that is BOTH graph-broken and format-refused, so order is visible. */
  function doublyBroken(): Schema {
    const post = s.model({ id: s.string().id() });
    const user = s.model({
      id: s.string().id(),
      createdAt: s.dateTime().default(() => new Date()),
      posts: s.toMany(() => post),
    });
    return { user, post };
  }

  it("refuses the graph BEFORE emitting a single node", () => {
    let thrown: unknown;
    try {
      serializeSchema(doublyBroken(), { validate: true });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SchemaValidationError);
    expect(
      thrown instanceof SchemaValidationError
        ? thrown.issues.map((issue) => issue.code)
        : []
    ).toEqual(["R002"]);
    // The default reaches the serializer, which finds the OTHER fault first.
    expect(issues(refusal(doublyBroken()))).toEqual([
      "[J009] /models/user/fields/createdAt/default",
    ]);
  });

  it("binds the passed record's keys, which the default deliberately does not", () => {
    const account = s.model({ id: s.string().id() });
    serializeSchema({ account }, { validate: true });
    expect(account["~"].names.ts).toBe("account");
  });

  it("settles every relation target, which the default deliberately does not", () => {
    let post = s.model({ id: s.string().id(), authors: s.toMany(() => user) });
    const user = s.model({ id: s.string().id(), posts: s.toMany(() => post) });
    const settled = post;
    serializeSchema({ user, post }, { validate: true });
    post = s.model({ id: s.string().id(), authors: s.toMany(() => user) });
    expect(user["~"].state.relations.posts?.["~"].settleTarget()).toBe(settled);
  });

  it("emits the same document the default emits, for a schema that passes", () => {
    const withOption = s.model({ id: s.string().id(), email: s.string() });
    const withoutOption = s.model({ id: s.string().id(), email: s.string() });
    expect(serializeSchema({ user: withOption }, { validate: true })).toEqual(
      serializeSchema({ user: withoutOption })
    );
  });
});

describe("builder refusals", () => {
  /**
   * A caller-supplied Standard Schema is read at BUILD time — `.schema(v)` grabs
   * `v["~standard"].validate` immediately — so a validator object whose accessor
   * throws makes a builder throw something that is not an `Error`. The document
   * location is still attached.
   */
  it("attaches the document location to a non-Error builder throw", () => {
    const hostile: StandardSchemaV1<string, string> = {
      get "~standard"(): StandardSchemaV1.Props<string, string> {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw "not an error";
      },
    };
    let refused: ValidationError | undefined;
    try {
      attachFieldSchemas(parseSchema(MINIMAL), { "user.id": hostile });
    } catch (thrown) {
      if (thrown instanceof ValidationError) refused = thrown;
    }
    expect(refused?.issues[0]?.path).toBe("/models/user/fields/id/schema");
    expect(refused?.issues[0]?.message).toContain("[J010]");
  });

  /**
   * Normalizing a non-Error throw means converting it to text, and a
   * caller-supplied object's own `toString` is caller code as well. The one
   * thing that must survive it is this boundary's refusal.
   */
  it("survives a builder throw whose own string conversion throws", () => {
    const hostile: StandardSchemaV1<string, string> = {
      get "~standard"(): StandardSchemaV1.Props<string, string> {
        // biome-ignore lint/style/useThrowOnlyError: a non-Error throw is the point
        throw {
          toString() {
            throw new Error("toString threw");
          },
        };
      },
    };
    let refused: ValidationError | undefined;
    try {
      attachFieldSchemas(parseSchema(MINIMAL), { "user.id": hostile });
    } catch (thrown) {
      if (thrown instanceof ValidationError) refused = thrown;
    }
    expect(refused?.issues[0]?.path).toBe("/models/user/fields/id/schema");
    expect(refused?.issues[0]?.message).toContain("[J010]");
  });
});

describe("never interned", () => {
  /**
   * The parser must be a pure function from document to a FRESH graph. A parser
   * that memoized models would hand the same object to two schemas, and the
   * write-once naming contract punishes exactly that.
   */
  it("lets two parses of one document bind different schema keys", () => {
    const document = {
      version: 1,
      models: {
        user: {
          fields: {
            id: { type: "string", id: true },
            posts: { type: "toMany", target: "post" },
          },
        },
        post: {
          fields: {
            id: { type: "string", id: true },
            authorId: { type: "string" },
            author: {
              type: "toOne",
              target: "user",
              fields: ["authorId"],
              references: ["id"],
            },
          },
        },
      },
    };
    const first = parseSchema(document);
    const { user, post } = parseSchema(document);
    if (!(user && post)) throw new Error("the document declares two models");
    hydrateSchemaNames(first);
    expect(() =>
      hydrateSchemaNames({ account: user, entry: post })
    ).not.toThrow();
    expect(first.user?.["~"].names.ts).toBe("user");
    expect(user["~"].names.ts).toBe("account");
  });

  it("refuses a second key for one model object, which is what interning would do", () => {
    const document = {
      version: 1,
      models: { user: { fields: { id: { type: "string", id: true } } } },
    };
    const { user } = parseSchema(document);
    if (!user) throw new Error("the document declares one model");
    hydrateSchemaNames({ user });
    expect(() => hydrateSchemaNames({ account: user })).toThrow(
      SchemaValidationError
    );
  });
});
