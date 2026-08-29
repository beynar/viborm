/**
 * Decimal Update — the exact-one union.
 *
 * The old shape was one partial bag holding every numeric operation, so `{}`
 * validated and reached a late `QueryEngineError` with an empty key list, and
 * `{ set, increment }` validated and let the builder silently apply the first
 * key it recognized. Neither is representable now, at the type level or at
 * runtime, which is what lets the query engine keep no precedence ladder for
 * decimals — the one in `set-builder.ts` still serves int, number and bigint,
 * whose bags this rule deliberately does not touch.
 */

import { decimal, int } from "@schema/scalars";
import { type InferInput, type InferOutput, parse } from "@validation";
import { type GetScalarSchemas, getScalarSchemas } from "@validation/scalars";
import { describe, expect, expectTypeOf, test } from "vitest";

const MONEY = { precision: 10, scale: 2 } as const;
const scalarSchemas = getScalarSchemas(decimal(MONEY)["~"].state);
const listSchemas = getScalarSchemas(decimal(MONEY).array()["~"].state);
const intSchemas = getScalarSchemas(int()["~"].state);

type DecimalState = (typeof decimalScalar)["~"]["state"];
type ScalarUpdate = InferInput<GetScalarSchemas<DecimalState>["update"]>;
type ScalarUpdateOutput = InferOutput<GetScalarSchemas<DecimalState>["update"]>;
const decimalScalar = decimal(MONEY);

describe("decimal update — types", () => {
  test("type: each operation is spellable alone", () => {
    expectTypeOf<{ set: string }>().toExtend<ScalarUpdate>();
    expectTypeOf<{ increment: string }>().toExtend<ScalarUpdate>();
    expectTypeOf<{ decrement: number }>().toExtend<ScalarUpdate>();
    expectTypeOf<{ multiply: string }>().toExtend<ScalarUpdate>();
    expectTypeOf<{ divide: string }>().toExtend<ScalarUpdate>();
  });

  test("type: output names the same exact-one value runtime emits", () => {
    expectTypeOf<{ set: string }>().toExtend<ScalarUpdateOutput>();
    expectTypeOf<{ increment: string }>().toExtend<ScalarUpdateOutput>();
    expectTypeOf<{
      set: string;
      increment: string;
    }>().not.toExtend<ScalarUpdateOutput>();
  });

  test("type: two operations and the empty bag are unrepresentable", () => {
    expectTypeOf<{
      set: string;
      increment: string;
    }>().not.toExtend<ScalarUpdate>();
    expectTypeOf<{
      increment: string;
      decrement: string;
    }>().not.toExtend<ScalarUpdate>();
    expectTypeOf<Record<string, never>>().not.toExtend<ScalarUpdate>();
  });

  test("type: refusal is STRUCTURAL, so a held payload is refused too", () => {
    // Excess-property checking only fires on a fresh object literal. `?: never`
    // on the keys an arm does not carry is what refuses a bag from a variable.
    const held = { set: "1", increment: "2" };
    expectTypeOf(held).not.toExtend<ScalarUpdate>();
  });

  test("type: an unknown key beside a real operation is refused fresh", () => {
    // FRESH: excess-property checking sees a literal written at the call site.
    // @ts-expect-error - 'incremnt' is not one of the five operations
    const fresh: ScalarUpdate = { increment: "1", incremnt: "1" };
    expect(parse(scalarSchemas.update, fresh).issues).toBeDefined();
  });
});

describe("decimal update — exactly one operation", () => {
  const update = scalarSchemas.update;

  test.each([
    ["set", { set: "1.50" }, { set: "1.5" }],
    ["increment", { increment: "0.010" }, { increment: "0.01" }],
    ["decrement", { decrement: 2 }, { decrement: "2" }],
    ["multiply", { multiply: "1.50" }, { multiply: "1.5" }],
    ["divide", { divide: "2" }, { divide: "2" }],
  ])("accepts %s alone", (_name, payload, expected) => {
    expect(parse(update, payload)).toEqual({ value: expected });
  });

  test("accepts the shorthand, which is the set arm", () => {
    expect(parse(update, "1.50")).toEqual({ value: { set: "1.5" } });
  });

  test.each([
    ["an empty object", {}],
    ["two operations", { set: "1", increment: "2" }],
    ["two arithmetic operations", { increment: "1", decrement: "2" }],
    [
      "all five",
      {
        set: "1",
        increment: "1",
        decrement: "1",
        multiply: "1",
        divide: "1",
      },
    ],
  ])("refuses %s", (_name, payload) => {
    expect(parse(update, payload).issues).toBeDefined();
  });

  test("refuses an unknown key beside a real one", () => {
    expect(
      parse(update, { increment: "1", incremnt: "1" }).issues
    ).toBeDefined();
    // The control: the real key alone is accepted.
    expect(parse(update, { increment: "1" }).issues).toBeUndefined();
  });

  test("refuses an explicit undefined, which names no operation", () => {
    expect(parse(update, { increment: undefined }).issues).toBeDefined();
    expect(
      parse(update, { set: "1", increment: undefined }).issues
    ).toBeDefined();
  });

  test("refuses an INHERITED operation key", () => {
    // The exact-one preflight owns the full prototype walk before the ordinary
    // object schema sees a trusted one-key carrier.
    const inherited = Object.create({ increment: "1" });
    expect(parse(update, inherited).issues).toBeDefined();
    // The control: the same value, written down, is accepted.
    expect(parse(update, { increment: "1" }).issues).toBeUndefined();
  });

  test("refuses an own set over inherited arithmetic", () => {
    const carrier: Record<string, unknown> = Object.create({ increment: "5" });
    carrier.set = "1";
    expect(parse(update, carrier).issues).toBeDefined();
  });

  test("refuses an own set over inherited class-prototype arithmetic", () => {
    class Money {
      set = "1";
    }
    Reflect.defineProperty(Money.prototype, "multiply", {
      get: () => "3",
      enumerable: true,
      configurable: true,
    });
    expect(parse(update, new Money()).issues).toBeDefined();
  });

  test("refuses a non-enumerable unknown key on a custom prototype", () => {
    const prototype = Object.create(null);
    Object.defineProperty(prototype, "hidden", { value: true });
    const carrier = Object.assign(Object.create(prototype), { set: "1" });
    expect(parse(update, carrier).issues).toBeDefined();
  });

  test("refuses an inherited allowed key on Object.prototype", () => {
    let issues: unknown;
    try {
      Reflect.defineProperty(Object.prototype, "set", {
        value: "9",
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const parsed = parse(update, { increment: "1.00" });
      issues = parsed.issues;
    } finally {
      Reflect.deleteProperty(Object.prototype, "set");
    }
    expect(issues).toBeDefined();
  });

  test("refuses a non-enumerable unknown key on Object.prototype", () => {
    let issues: unknown;
    try {
      Reflect.defineProperty(Object.prototype, "hiddenDecimalOperation", {
        value: "9",
        configurable: true,
      });
      issues = parse(update, { set: "1" }).issues;
    } finally {
      Reflect.deleteProperty(Object.prototype, "hiddenDecimalOperation");
    }
    expect(issues).toBeDefined();
  });

  test("rejects symbols, hidden unknowns, and enumerable inherited unknowns", () => {
    const symbol = { increment: "1", [Symbol("extra")]: true };
    const hidden = { increment: "1" };
    Object.defineProperty(hidden, "extra", { value: true });
    const inherited = Object.assign(Object.create({ extra: true }), {
      increment: "1",
    });

    expect(parse(update, symbol).issues).toBeDefined();
    expect(parse(update, hidden).issues).toBeDefined();
    expect(parse(update, inherited).issues).toBeDefined();
    expect(parse(update, { [Symbol("operation")]: "1" }).issues).toBeDefined();
  });

  test("refuses a cyclic hostile prototype chain", () => {
    const prototypeTarget = Object.create(null);
    let cyclicPrototype: object;
    cyclicPrototype = new Proxy(prototypeTarget, {
      getPrototypeOf: () => cyclicPrototype,
    });
    const payload = new Proxy(
      { increment: "1" },
      { getPrototypeOf: () => cyclicPrototype }
    );

    expect(parse(update, payload).issues).toBeDefined();
  });

  test("owns revoked proxies and failing reflection traps as issues", () => {
    const revoked = Proxy.revocable({ increment: "1" }, {});
    revoked.revoke();
    expect(() => parse(update, revoked.proxy)).not.toThrow();
    expect(parse(update, revoked.proxy).issues).toBeDefined();

    const hostile = new Proxy(
      { increment: "1" },
      {
        ownKeys() {
          throw new Error("ownKeys trap");
        },
      }
    );
    expect(() => parse(update, hostile)).not.toThrow();
    expect(parse(update, hostile).issues).toBeDefined();
  });

  test("reads an accessor once and emits one null-prototype key", () => {
    let reads = 0;
    const payload = {
      get increment() {
        reads += 1;
        return "1.00";
      },
    };
    const parsed = parse(update, payload);
    if (parsed.issues) throw new Error("Expected an accepted increment");
    expect(reads).toBe(1);
    expect(Object.getPrototypeOf(parsed.value)).toBe(null);
    expect(Object.entries(parsed.value)).toEqual([["increment", "1"]]);
  });

  test("owns a throwing operation accessor as issues", () => {
    const payload = {
      get increment(): string {
        throw new Error("operand trap");
      },
    };
    expect(() => parse(update, payload)).not.toThrow();
    expect(parse(update, payload).issues).toBeDefined();
  });

  test("does not relabel an external field-schema failure as a carrier refusal", () => {
    const cause = new Error("external decimal schema exploded");
    const schema = getScalarSchemas(
      decimal(MONEY).schema({
        "~standard": {
          version: 1,
          vendor: "decimal-update-test",
          validate() {
            throw cause;
          },
        },
      })["~"].state
    ).update;

    expect(() => schema["~standard"].validate({ set: "1" })).toThrow(cause);
  });

  test("refuses a non-record through the object schema's own type refusal", () => {
    expect(parse(update, true).issues).toBeDefined();
    expect(parse(update, []).issues).toBeDefined();
  });

  test("keeps the operand's own message rather than a union summary", () => {
    // A union of five single-key objects would have rewritten every operand
    // message into "did not match any union member".
    const result = parse(update, { increment: "1.005" });
    if (!result.issues) throw new Error("Expected a refusal");
    expect(result.issues[0]?.message).toContain("fractional digit");
  });

  test("names the rule when no single operation was given", () => {
    const result = parse(update, { set: "1", increment: "1" });
    if (!result.issues) throw new Error("Expected a refusal");
    expect(result.issues[0]?.message).toContain(
      "exactly one operation: set, increment, decrement, multiply, divide"
    );
  });

  test("int keeps its partial bag: this rule is scoped to decimals", () => {
    // The engine's precedence ladder still serves the other numeric scalars,
    // and removing it for them has no plan authority.
    expect(parse(intSchemas.update, {}).issues).toBeUndefined();
    expect(
      parse(intSchemas.update, { set: 1, increment: 2 }).issues
    ).toBeUndefined();
  });
});

describe("decimal list update — exactly one operation", () => {
  const update = listSchemas.update;

  test.each([
    ["set", { set: ["1.50"] }, { set: ["1.5"] }],
    ["push one", { push: "1.50" }, { push: ["1.5"] }],
    ["push many", { push: ["1", "2"] }, { push: ["1", "2"] }],
    ["push none", { push: [] }, { push: [] }],
    ["unshift one", { unshift: "1.50" }, { unshift: ["1.5"] }],
  ])("accepts %s alone", (_name, payload, expected) => {
    expect(parse(update, payload)).toEqual({ value: expected });
  });

  test("accepts the whole-list shorthand", () => {
    expect(parse(update, ["1.50"])).toEqual({ value: { set: ["1.5"] } });
  });

  test.each([
    ["an empty object", {}],
    ["two operations", { set: ["1"], push: ["2"] }],
    ["push and unshift", { push: ["1"], unshift: ["2"] }],
    ["an unknown key beside a real one", { push: ["1"], psuh: ["2"] }],
    ["an explicit undefined", { push: undefined }],
  ])("refuses %s", (_name, payload) => {
    expect(parse(update, payload).issues).toBeDefined();
  });

  test("refuses an INHERITED list operation key", () => {
    expect(parse(update, Object.create({ push: ["1"] })).issues).toBeDefined();
  });

  test("refuses an own list operation over an inherited one", () => {
    const carrier: Record<string, unknown> = Object.create({ push: ["9"] });
    carrier.set = ["1"];
    expect(parse(update, carrier).issues).toBeDefined();
  });

  test("refuses an inherited list operation on Object.prototype", () => {
    let issues: unknown;
    try {
      Reflect.defineProperty(Object.prototype, "set", {
        value: ["9"],
        enumerable: true,
        configurable: true,
        writable: true,
      });
      const parsed = parse(update, { push: "1.00" });
      issues = parsed.issues;
    } finally {
      Reflect.deleteProperty(Object.prototype, "set");
    }
    expect(issues).toBeDefined();
  });

  test("exposes no arithmetic on a list", () => {
    // A list has no numeric list semantics to invent.
    for (const key of ["increment", "decrement", "multiply", "divide"]) {
      expect(parse(update, { [key]: "1" }).issues).toBeDefined();
    }
  });

  test("keeps each list operation's operand refusal", () => {
    expect(parse(update, { set: [true] }).issues).toBeDefined();
    expect(parse(update, { push: {} }).issues).toBeDefined();
    expect(parse(update, { unshift: {} }).issues).toBeDefined();
  });
});
