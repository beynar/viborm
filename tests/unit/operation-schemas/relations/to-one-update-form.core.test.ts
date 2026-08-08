import {
  readToOneUpdateForm,
  splitToOneUpdateTarget,
  toOneUpdateEnvelope,
} from "@validation/relations/to-one-update-form";
import { describe, expect, test } from "vitest";

describe("to-one update forms", () => {
  test("distinguishes bare, envelope, and ambiguous payloads", () => {
    expect(readToOneUpdateForm({ name: "Ada" }, false)).toBe("bare");
    expect(readToOneUpdateForm({ data: { name: "Ada" } }, false)).toBe(
      "envelope"
    );
    expect(readToOneUpdateForm({ data: { name: "Ada" } }, true)).toBe(
      "ambiguous"
    );
    expect(
      readToOneUpdateForm({ where: {}, data: { name: "Ada" } }, true)
    ).toBe("envelope");
  });

  test("treats non-plain data values as bare field data", () => {
    class DocumentValue {
      readonly name = "Ada";
    }

    expect(readToOneUpdateForm({ data: new DocumentValue() }, true)).toBe(
      "bare"
    );
    expect(readToOneUpdateForm({ data: [] }, true)).toBe("bare");
    expect(readToOneUpdateForm(null, true)).toBe("bare");
  });

  test("accepts null-prototype envelopes", () => {
    const envelope = Object.assign(Object.create(null), {
      data: Object.assign(Object.create(null), { name: "Ada" }),
    });

    expect(readToOneUpdateForm(envelope, false)).toBe("envelope");
  });

  test("canonicalizes bare updates and marks data-field collisions", () => {
    const data = { name: "Ada" };

    expect(toOneUpdateEnvelope(data, false)).toEqual({ data });
    expect(toOneUpdateEnvelope(data, true)).toEqual({ where: {}, data });
  });

  test("splits canonical envelopes and drops empty filters", () => {
    const data = { name: "Ada" };

    expect(splitToOneUpdateTarget({ data })).toEqual({ data });
    expect(splitToOneUpdateTarget({ data, where: {} })).toEqual({ data });
    expect(splitToOneUpdateTarget({ data, where: { active: true } })).toEqual({
      data,
      filter: { active: true },
    });
  });
});
