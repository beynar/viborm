import { type AnyFieldRef, FIELD_REF_BRAND } from "@schema/field-ref";
import { s } from "@schema";
import { sql } from "@sql";
import { parse, v } from "@validation";
import { runInOperandScope } from "@validation/primitives/operand";
import { describe, expect, test } from "vitest";

const model = s.model({ views: s.int(), likes: s.int() });
const operand = v.comparisonOperand("int", v.integer());

const fieldRef = (type: "int" | "string" = "int", list = false): AnyFieldRef =>
  Object.freeze({
    [FIELD_REF_BRAND]: Object.freeze({
      model: "post",
      field: "likes",
      type,
      list,
    }),
  });

describe("comparison operands", () => {
  test("accepts literal values, references, and SQL fragments", () => {
    expect(parse(operand, 3)).toEqual({ value: 3 });
    expect(parse(operand, fieldRef()).issues).toBeUndefined();
    expect(parse(operand, sql`views + 1`).issues).toBeUndefined();
  });

  test("refuses callbacks outside a model scope", () => {
    const result = parse(operand, (context: unknown) => context);

    expect(result.issues?.[0]?.message).toContain("only meaningful inside");
  });

  test("resolves reference and SQL callbacks in the active model scope", () => {
    let firstContext: unknown;
    let secondContext: unknown;

    const reference = runInOperandScope(model, () =>
      parse(operand, (context) => {
        firstContext = context;
        return context.fields.likes;
      })
    );
    const fragment = runInOperandScope(model, () =>
      parse(operand, (context) => {
        secondContext = context;
        return context.sql`views + 1`;
      })
    );

    expect(reference.issues).toBeUndefined();
    expect(fragment.issues).toBeUndefined();
    expect(secondContext).toBe(firstContext);
  });

  test("restores an enclosing model scope after nested validation", () => {
    const other = s.model({ count: s.int() });
    let outerContext: unknown;
    let restoredContext: unknown;

    runInOperandScope(model, () => {
      parse(operand, (context) => {
        outerContext = context;
        return context.fields.views;
      });
      runInOperandScope(other, () =>
        parse(operand, (context) => context.fields.count)
      );
      parse(operand, (context) => {
        restoredContext = context;
        return context.fields.likes;
      });
    });

    expect(restoredContext).toBe(outerContext);
  });

  test("turns callback throws and invalid returns into issues", () => {
    const thrownError = runInOperandScope(model, () =>
      parse(operand, () => {
        throw new Error("callback exploded");
      })
    );
    const thrownValue = runInOperandScope(model, () =>
      parse(operand, () => {
        throw "callback refused";
      })
    );
    const promised = runInOperandScope(model, () =>
      parse(operand, async () => fieldRef())
    );

    expect(thrownError.issues?.[0]?.message).toContain("callback exploded");
    expect(thrownValue.issues?.[0]?.message).toContain("callback refused");
    expect(promised.issues?.[0]?.message).toContain("cannot be async");

    for (const invalid of [null, [], 1]) {
      const result = runInOperandScope(model, () =>
        operand["~standard"].validate(() => invalid)
      );
      expect(result.issues?.[0]?.message).toContain("must return");
    }
  });

  test("refuses list and mismatched field references", () => {
    expect(
      parse(operand, fieldRef("int", true)).issues?.[0]?.message
    ).toContain("list fields");
    expect(parse(operand, fieldRef("string")).issues?.[0]?.message).toContain(
      "a 'int' operand"
    );
  });

  test("fieldRefOr accepts a matching reference and ordinary values", () => {
    const referenceOrValue = v.fieldRefOr("int", v.integer());

    expect(parse(referenceOrValue, fieldRef()).issues).toBeUndefined();
    expect(parse(referenceOrValue, 2)).toEqual({ value: 2 });
  });

  test("mirrors optionality from the wrapped value schema", () => {
    expect(v.comparisonOperand("int", v.integer()).acceptsUndefined).toBe(
      false
    );
    expect(
      v.comparisonOperand("int", v.integer({ optional: true })).acceptsUndefined
    ).toBe(true);
    expect(v.fieldRefOr("int", v.integer()).acceptsUndefined).toBe(false);
    expect(
      v.fieldRefOr("int", v.integer({ optional: true })).acceptsUndefined
    ).toBe(true);
  });
});

describe("closed operands", () => {
  test("noOperandExpression refuses SQL while noFieldRef keeps it", () => {
    const fragment = sql`views + 1`;
    const source = v.coerce(v.literal("go"), () => ({ nested: fragment }));

    expect(parse(v.noFieldRef(source, "JSON"), "go").issues).toBeUndefined();
    expect(
      parse(v.noOperandExpression(source, "having"), "go").issues?.[0]?.message
    ).toContain("SQL fragment");
  });

  test("scanner ignores ArrayBuffer values", () => {
    const buffer = new ArrayBuffer(8);
    const source = v.coerce(v.literal("go"), () => ({ buffer }));

    expect(
      parse(v.noOperandExpression(source, "having"), "go").issues
    ).toBeUndefined();
  });
});
