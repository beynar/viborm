/**
 * Plan 2.1's list exclusion, at the declaration that writes it.
 *
 * "Fixed-decimal lists cannot be IDs, unique fields, index members, foreign-key
 * members, or relation identity members." The two positions a SCALAR chain can
 * name are `.id()` and `.unique()`, and it can name them from either direction:
 * `.array().id()` and `.id().array()` are the same illegal declaration written
 * in two orders, so both are refused here.
 *
 * The other three positions are named by STRING from the model and the relation
 * — an index, a compound key, a `.fields(...)` tuple — so the declaration never
 * sees them; their witnesses live beside their own owners in
 * `tests/unit/schema-validation/decimal-list-key-positions.core.test.ts`.
 */

import { ValidationError } from "@errors";
import { s } from "@schema";
import { describe, expect, test } from "vitest";

const MONEY = { precision: 10, scale: 2 } as const;

const ID_REFUSAL = /cannot be an ID/i;
const UNIQUE_REFUSAL = /unique field/i;
const LIST_REFUSAL = /cannot become a list/i;

function refusalOf(build: () => unknown): ValidationError {
  try {
    build();
  } catch (error) {
    if (error instanceof ValidationError) return error;
    throw error;
  }
  throw new Error("expected a definition-boundary refusal");
}

describe("a fixed-decimal list is not a key", () => {
  test(".array().id() is refused in the builder's own voice", () => {
    // @ts-expect-error - a fixed-decimal list cannot be a key
    const error = refusalOf(() => s.decimal(MONEY).array().id());

    expect(error.source).toMatchObject({
      kind: "schema-builder",
      builder: "s.decimal",
      path: "id",
    });
    expect(error.message).toMatch(ID_REFUSAL);
  });

  test(".array().unique() is refused", () => {
    // @ts-expect-error - a fixed-decimal list cannot be a key
    const error = refusalOf(() => s.decimal(MONEY).array().unique());

    expect(error.source).toMatchObject({ path: "unique" });
    expect(error.message).toMatch(UNIQUE_REFUSAL);
  });

  test(".id().array() is refused from the other direction", () => {
    // @ts-expect-error - a decimal key cannot become a list
    const error = refusalOf(() => s.decimal(MONEY).id().array());

    expect(error.source).toMatchObject({ path: "array" });
    expect(error.message).toMatch(LIST_REFUSAL);
  });

  test(".unique().array() is refused", () => {
    // @ts-expect-error - a decimal key cannot become a list
    const error = refusalOf(() => s.decimal(MONEY).unique().array());

    expect(error.source).toMatchObject({ path: "array" });
  });

  test("a nullable list carries the refusal too", () => {
    // `.nullable()` rebuilds the state, and the arity has to survive that
    // rebuild or the exclusion would be one modifier deep.
    // @ts-expect-error - a fixed-decimal list cannot be a key
    expect(() => s.decimal(MONEY).array().nullable().unique()).toThrow(
      ValidationError
    );
  });

  test("every legal chain still builds", () => {
    expect(s.decimal(MONEY).id()["~"].state.isId).toBe(true);
    expect(s.decimal(MONEY).unique()["~"].state.isUnique).toBe(true);
    expect(s.decimal(MONEY).array()["~"].state.array).toBe(true);
    expect(
      s.decimal(MONEY).array().nullable().default(null)["~"].state.array
    ).toBe(true);
    // The descriptor is still the same frozen object after the chain.
    const domain = s.decimal(MONEY);
    expect(domain.array()["~"].state.decimal).toBe(domain["~"].state.decimal);
  });

  test("a list of another scalar type is untouched", () => {
    // The exclusion speaks for the fixed decimal. F007 remains the generic
    // whole-schema rule for an ID that is an array of anything.
    expect(s.string().array().unique()["~"].state.isUnique).toBe(true);
  });
});
