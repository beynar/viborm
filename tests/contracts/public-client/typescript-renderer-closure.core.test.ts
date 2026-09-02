/**
 * Degenerate but legal domains the public TypeScript renderer still has to
 * answer exactly, plus the two public-introspection spellings that decide
 * whether a bulk write renders its count carrier or its row projection.
 */

import {
  renderOperationResultType,
  renderSchemaType,
} from "@client/schema-introspection";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const record = s.model({
  id: s.string().id(),
  label: s.string(),
});
const recordSchema = { record };

const article = s.model({ id: s.string().id(), title: s.string() });
const clip = s.model({ id: s.string().id(), duration: s.int() });
const shelf = s.model({
  id: s.string().id(),
  items: s.toMany({ article: () => article, clip: () => clip }),
});
const shelfSchema = { article, clip, shelf };

const blank = s.model({});
const blankSchema = { blank };

describe("TypeScript renderer degenerate domains", () => {
  test("renders an enum declaring no member as an uninhabited field", () => {
    const ticket = s.model({ state: s.enum([]) });

    expect(renderSchemaType({ ticket })).toBe(`type VibORMSchema = {
  ticket: {
    state: never;
  };
};`);
  });

  test("renders a collection that admits no variant as a readonly never array", () => {
    // `only: []` is a legal request for "no variants", so its element type has
    // no inhabitant while the carrier itself stays a readonly collection.
    expect(
      renderOperationResultType(shelfSchema, "shelf", "findMany", {
        select: { items: { only: [] } },
      })
    ).toBe(`Array<{
  items: ReadonlyArray<never>;
}>`);
  });

  test("renders a row carrying no readable column as an empty object", () => {
    expect(
      renderOperationResultType(blankSchema, "blank", "findFirst", {})
    ).toBe("{} | null");
  });
});

describe("public introspection payload defaults", () => {
  test("reads an absent payload as the empty payload", () => {
    expect(
      renderOperationResultType(recordSchema, "record", "findMany", undefined)
    ).toBe(`Array<{
  id: string;
  label: string;
}>`);
  });

  test("keeps an unprojected updateMany on its count carrier", () => {
    expect(
      renderOperationResultType(recordSchema, "record", "updateMany", {
        data: { label: "renamed" },
      })
    ).toBe(`{
  count: number;
}`);
  });
});
