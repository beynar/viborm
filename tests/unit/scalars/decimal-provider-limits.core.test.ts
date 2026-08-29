import { s } from "@schema";
import {
  describeDecimalProviderLimitRefusal,
  findDecimalProviderLimitRefusal,
} from "@schema/scalars/decimal/provider-limits";
import { describe, expect, it } from "vitest";

const schemaWith = (precision: number, scale: number) => ({
  ledger: s.model({
    id: s.string().id(),
    amount: s.decimal({ precision, scale }),
  }),
});

describe("decimal provider limits", () => {
  it("admits a fitting domain after skipping ordinary scalars", () => {
    expect(
      findDecimalProviderLimitRefusal(schemaWith(18, 0), "sqlite")
    ).toBeUndefined();
  });

  it.each([
    ["postgresql", 1001, 2, "maximum precision of 1000"],
    ["mysql", 66, 2, "maximum precision of 65"],
    ["sqlite", 19, 0, "maximum precision of 18"],
  ] as const)("names the first %s refusal with its model and field", (dialect, precision, scale, expectedReason) => {
    const refusal = findDecimalProviderLimitRefusal(
      schemaWith(precision, scale),
      dialect
    );

    expect(refusal).toMatchObject({
      modelName: "ledger",
      fieldName: "amount",
      dialect,
      descriptor: { precision, scale },
      reason: expect.stringContaining(expectedReason),
    });
    if (refusal === undefined) throw new Error("expected provider refusal");
    expect(describeDecimalProviderLimitRefusal(refusal)).toContain(
      `Decimal field 'ledger.amount' cannot be stored by the '${dialect}' driver`
    );
  });
});
