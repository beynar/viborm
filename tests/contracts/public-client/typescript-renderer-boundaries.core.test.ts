import {
  renderOperationResultType,
  renderSchemaType,
} from "@client/schema-introspection";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

describe("TypeScript renderer public boundaries", () => {
  test("quotes enum literal values that are not TypeScript identifiers", () => {
    const auditLog = s.model({
      status: s.enum(["active-user", "postal code", 'needs"review']),
    });

    expect(renderSchemaType({ auditLog })).toBe(`type VibORMSchema = {
  auditLog: {
    status: "active-user" | "postal code" | "needs\\"review";
  };
};`);
  });

  test("renders an empty structural model as an empty object", () => {
    expect(renderSchemaType({ empty: s.model({}) })).toBe(`type VibORMSchema = {
  empty: {};
};`);
  });

  test("renders aggregate count, minimum, and maximum leaf domains", () => {
    const record = s.model({
      id: s.string().id(),
      label: s.string(),
      score: s.int(),
    });

    expect(
      renderOperationResultType({ record }, "record", "aggregate", {
        _count: { label: true },
        _min: { label: true },
        _max: { score: true },
      })
    ).toBe(`{
  _count: {
    label: number;
  };
  _min: {
    label: string | null;
  };
  _max: {
    score: number | null;
  };
}`);
  });

  test("keeps throwing reads non-null and renders an upsert projection", () => {
    const record = s.model({
      id: s.string().id(),
      label: s.string(),
    });
    const schema = { record };

    expect(
      renderOperationResultType(schema, "record", "findFirstOrThrow", {
        select: { label: true },
      })
    ).toBe(`{
  label: string;
}`);
    expect(
      renderOperationResultType(schema, "record", "upsert", {
        where: { id: "record-1" },
        create: { id: "record-1", label: "created" },
        update: { label: "updated" },
        select: { id: true },
      })
    ).toBe(`{
  id: string;
}`);
  });
});
