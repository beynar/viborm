import { s } from "@src/schema";
import { validateSchema } from "@src/schema/validation";
import { describe, expect, it } from "vitest";

function errorCodes(models: Parameters<typeof validateSchema>[0]): string[] {
  return validateSchema(models).errors.map((issue) => issue.code);
}

function warningCodes(models: Parameters<typeof validateSchema>[0]): string[] {
  return validateSchema(models).warnings.map((issue) => issue.code);
}

describe("model definition rules", () => {
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

  it("retains unknown compound fields so validation can reject them", () => {
    const base = s.model({ id: s.string().id(), tenant: s.string() });
    const invalidId = Reflect.apply(base.id, base, [["missing"]]);
    const invalidUnique = Reflect.apply(base.unique, base, [["unknown"]]);

    expect(errorCodes({ invalidId })).toContain("I003");
    expect(errorCodes({ invalidUnique })).toContain("I003");
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
