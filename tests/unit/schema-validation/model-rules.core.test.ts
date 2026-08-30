import { s } from "@src/schema";
import { hydrateSchemaNames } from "@src/schema/hydration";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

const DUPLICATE_KEY_MEMBER = /cannot repeat a field/i;
const DENSE_STRING_MEMBERS = /fields must be a dense array of strings/i;
const DUPLICATE_COMPOUND_NAME =
  /name '.*' is already used by another compound key/i;

function changingMemberIterator() {
  const fields: ("a" | "b")[] = ["a", "b"];
  let calls = 0;
  Object.defineProperty(fields, Symbol.iterator, {
    *value() {
      calls++;
      if (calls === 1) {
        yield "a";
        yield "b";
        return;
      }
      yield "a";
      yield "a";
    },
  });
  return { fields, iteratorCalls: () => calls };
}

function errorCodes(models: Parameters<typeof validateSchema>[0]): string[] {
  return validateSchema(models).errors.map((issue) => issue.code);
}

function warningCodes(models: Parameters<typeof validateSchema>[0]): string[] {
  return validateSchema(models).warnings.map((issue) => issue.code);
}

describe("model definition rules", () => {
  it.each([
    [
      "compound ID",
      () => s.model({ a: s.string(), b: s.string() }).id(["a", "a"]),
    ],
    [
      "compound unique",
      () => s.model({ a: s.string(), b: s.string() }).unique(["a", "a"]),
    ],
    [
      "index",
      () => s.model({ a: s.string(), b: s.string() }).index(["a", "a"]),
    ],
  ])("refuses duplicate members in one %s tuple", (_label, build) => {
    expect(build).toThrow(DUPLICATE_KEY_MEMBER);
  });

  it.each([
    ["non-array", null],
    ["sparse", new Array(1)],
    ["non-string", [42]],
  ])("refuses %s index members", (_label, fields) => {
    const model = s.model({ a: s.string() });
    expect(() => Reflect.apply(model.index, model, [fields])).toThrow(
      DENSE_STRING_MEMBERS
    );
  });

  it("snapshots index members without consulting a changing iterator", () => {
    const { fields, iteratorCalls } = changingMemberIterator();
    const model = s.model({ a: s.string(), b: s.string() }).index(fields);

    expect(iteratorCalls()).toBe(0);
    expect(model["~"].state.indexes[0]?.fields).toEqual(["a", "b"]);
  });

  it("snapshots compound ID members without consulting a changing iterator", () => {
    const { fields, iteratorCalls } = changingMemberIterator();
    const model = s.model({ a: s.string(), b: s.string() }).id(fields);

    expect(iteratorCalls()).toBe(0);
    const compound = Reflect.get(model["~"].state.compoundId ?? {}, "a_b");
    expect(Object.keys(Reflect.get(compound, "entries") ?? {})).toEqual([
      "a",
      "b",
    ]);
  });

  it("snapshots compound unique members without consulting a changing iterator", () => {
    const { fields, iteratorCalls } = changingMemberIterator();
    const model = s.model({ a: s.string(), b: s.string() }).unique(fields);

    expect(iteratorCalls()).toBe(0);
    const compound = Reflect.get(model["~"].state.compoundUniques ?? {}, "a_b");
    expect(Object.keys(Reflect.get(compound, "entries") ?? {})).toEqual([
      "a",
      "b",
    ]);
  });

  it("refuses two derived compound names whose underscore spelling collides", () => {
    const model = s
      .model({
        a_b: s.string(),
        c: s.string(),
        a: s.string(),
        b_c: s.string(),
      })
      .unique(["a_b", "c"]);

    expect(() => model.unique(["a", "b_c"])).toThrow(DUPLICATE_COMPOUND_NAME);
  });

  it("refuses an explicit compound name already used by another tuple", () => {
    const model = s
      .model({ a: s.string(), b: s.string(), c: s.string() })
      .unique(["a", "b"], { name: "lookup" });

    expect(() => model.unique(["b", "c"], { name: "lookup" })).toThrow(
      DUPLICATE_COMPOUND_NAME
    );
    expect(() => model.id(["b", "c"], { name: "lookup" })).toThrow(
      DUPLICATE_COMPOUND_NAME
    );
  });

  it("rejects a model with no scalar fields", () => {
    expect(errorCodes({ empty: s.model({}) })).toEqual(
      expect.arrayContaining(["M001", "M002"])
    );
  });

  it("rejects a direct default that does not satisfy its scalar", () => {
    const scalar = s.string();
    const invalidDefault = Reflect.apply(scalar.default, scalar, [42]);
    const model = s.model({ id: s.string().id(), value: invalidDefault });

    expect(errorCodes({ model })).toContain("F004");
  });

  it("rejects an array scalar used as a single-field ID", () => {
    const model = s.model({ id: s.string().array().id() });

    expect(errorCodes({ model })).toContain("F007");
  });

  it("warns when generation is configured without an ID", () => {
    const model = s.model({ id: s.string().id(), token: s.string().uuid() });

    expect(warningCodes({ model })).toContain("F008");
  });

  it("rejects an index field supplied by an untyped caller", () => {
    const model = s.model({ id: s.string().id() });
    const invalidIndex = Reflect.apply(model.index, model, [["missing"]]);

    expect(errorCodes({ invalidIndex })).toContain("I001");
  });

  it("refuses an unknown compound member at the declaring site", () => {
    const base = s.model({ id: s.string().id(), tenant: s.string() });

    expect(() => Reflect.apply(base.id, base, [["missing"]])).toThrow(
      "Compound ID field 'missing' does not exist"
    );
    expect(() => Reflect.apply(base.unique, base, [["unknown"]])).toThrow(
      "Compound unique field 'unknown' does not exist"
    );
  });

  it("refuses a relation named as a compound member", () => {
    const target = s.model({ id: s.string().id() });
    const base = s.model({
      region: s.string(),
      owner: s.toOne(() => target),
    });

    expect(() => Reflect.apply(base.id, base, [["region", "owner"]])).toThrow(
      "Compound ID field 'owner' is a relation and cannot be a key member"
    );
  });

  /**
   * The witness for the old misdirection: a typo'd compound-ID member used to
   * survive `.id()` as a refused schema, and on validation-rule-free paths the
   * first diagnostic was `[FK005] [region, slug] in 'post' should be unique/ID`
   * — pointing at the foreign key that referenced the INTENDED tuple, never at
   * the typo. The declaration now fails on its own line, naming the field.
   */
  it("fails a typo'd compound ID at its own declaration, not as FK005 at a referencing FK", () => {
    expect(() => {
      const withTypoId = s.model({
        region: s.string(),
        slug: s.string(),
        comments: s.toMany(() => comment),
      });
      const post = Reflect.apply(withTypoId.id, withTypoId, [
        ["region", "slgu"],
      ]);
      const comment = s.model({
        id: s.string().id(),
        postRegion: s.string(),
        postSlug: s.string(),
        post: s
          .toOne(() => post)
          .fields("postRegion", "postSlug")
          .references("region", "slug"),
      });
      return { post, comment };
    }).toThrow("Compound ID field 'slgu' does not exist");
  });

  it("rejects empty compound constraints", () => {
    const base = s.model({ id: s.string().id(), tenant: s.string() });
    const emptyId = Reflect.apply(base.id, base, [[]]);
    const emptyUnique = Reflect.apply(base.unique, base, [[]]);

    expect(errorCodes({ emptyId })).toContain("I003");
    expect(errorCodes({ emptyUnique })).toContain("I003");
  });

  it("rejects a scalar ID combined with a compound ID", () => {
    const model = s
      .model({ id: s.string().id(), tenant: s.string() })
      .id(["tenant"]);

    expect(errorCodes({ model })).toContain("F002");
  });
});

/**
 * A model's classified member maps are a projection of its shape: every shape
 * member the extractors recognize must appear in the map that claims it. A
 * shape key comes from the caller — a JSON document's field name, a generated
 * schema, a hand-written literal — so it can be any string, `__proto__`
 * included, and a map that loses such a member is a model whose scalars,
 * uniques and relations disagree with the shape they were read from.
 *
 * Legality of the key is a SEPARATE question with its own owner
 * (`isValidSchemaIdentifier`, enforced at hydration and by the JSON document
 * reader). These two witnesses are the pair: extraction keeps the member,
 * hydration then refuses it by name.
 */
describe("model member extraction", () => {
  // A computed key is an own data property; the bare `__proto__:` literal form
  // would set the object's prototype instead and never reach the model.
  const prototypeKey = "__proto__";

  it("classifies a shape member whose key is a prototype property name", () => {
    const tag = s.model({ id: s.string().id() });
    const model = s.model({
      id: s.string().id(),
      [prototypeKey]: s.string().unique(),
      toString: s.toMany(() => tag),
    });
    const state = model["~"].state;

    expect(Object.keys(state.shape)).toEqual(["id", prototypeKey, "toString"]);
    expect(Object.keys(state.scalars)).toEqual(["id", prototypeKey]);
    expect(Object.keys(state.uniques)).toEqual(["id", prototypeKey]);
    expect(Object.keys(state.relations)).toEqual(["toString"]);
  });

  it("classifies such a member added by .extends()", () => {
    const model = s
      .model({ id: s.string().id() })
      .extends({ [prototypeKey]: s.string() });
    const state = model["~"].state;

    expect(Object.keys(state.shape)).toEqual(["id", prototypeKey]);
    expect(Object.keys(state.scalars)).toEqual(["id", prototypeKey]);
  });

  it("keeps such a member usable as a compound key member", () => {
    const model = s
      .model({ id: s.string(), [prototypeKey]: s.string() })
      .id(["id", prototypeKey]);
    const constraint = model["~"].state.compoundId?.[`id_${prototypeKey}`];

    expect(Object.keys(constraint?.entries ?? {})).toEqual([
      "id",
      prototypeKey,
    ]);
  });

  /**
   * The member survives extraction so that the identifier owner can refuse it
   * loudly — surviving is not being granted a capability.
   */
  it("still refuses that field at hydration, naming it", () => {
    const model = s.model({
      id: s.string().id(),
      [prototypeKey]: s.string(),
    });

    expect(() => hydrateSchemaNames({ account: model })).toThrow(
      "Field '__proto__' in 'account' is invalid identifier"
    );
    expect(errorCodes({ account: model })).toContain("F001");
  });
});
