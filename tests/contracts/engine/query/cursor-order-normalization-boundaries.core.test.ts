import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import {
  buildNormalizedOrderBy,
  normalizeCursorOrder,
  reverseCursorOrder,
} from "@query-engine/operations/cursor-order";
import { s } from "@schema";
import { prepareSchema, scopeFor } from "@tests/fixtures/query-scope";
import { describe, expect, test } from "vitest";

const ordered = s
  .model({
    id: s.string().id(),
    alternate: s.string().unique(),
    rank: s.int().nullable(),
    label: s.string(),
  })
  .map("cursor_order_boundaries");

const keyless = s
  .model({
    label: s.string(),
  })
  .map("cursor_order_keyless");

prepareSchema({ ordered });
prepareSchema({ keyless });

describe("cursor total-order normalization", () => {
  test("keeps the first scalar order, its null placement, and one identity tie-breaker", () => {
    const scope = scopeFor(new PostgresAdapter(), ordered);
    const order = normalizeCursorOrder(
      scope,
      [
        { rank: { sort: "desc", nulls: "first" } },
        { rank: "asc" },
        { label: "asc" },
        { alternate: undefined },
      ],
      undefined,
      5,
      scope.rootAlias
    );

    expect(
      order?.map(({ field, direction, nulls, nullable, isTieBreaker }) => ({
        field,
        direction,
        nulls,
        nullable,
        isTieBreaker,
      }))
    ).toEqual([
      {
        field: "rank",
        direction: "desc",
        nulls: "first",
        nullable: true,
        isTieBreaker: false,
      },
      {
        field: "label",
        direction: "asc",
        nulls: "last",
        nullable: false,
        isTieBreaker: false,
      },
      {
        field: "id",
        direction: "asc",
        nulls: "last",
        nullable: false,
        isTieBreaker: true,
      },
    ]);
    if (!order) throw new Error("Expected a normalized cursor order.");
    expect(buildNormalizedOrderBy(scope, order)?.toStatement("$n")).toBe(
      '"t0"."rank" DESC NULLS FIRST, "t0"."label" ASC, "t0"."id" ASC'
    );
  });

  test("adds cursor discriminator fields after the row identity in model order", () => {
    const scope = scopeFor(new PostgresAdapter(), ordered);
    const order = normalizeCursorOrder(
      scope,
      undefined,
      [{ fieldName: "alternate", value: "cursor-alternate" }],
      undefined,
      scope.rootAlias
    );

    expect(order?.map(({ field, isTieBreaker }) => [field, isTieBreaker])).toEqual([
      ["id", true],
      ["alternate", true],
    ]);
  });

  test("gives take-only reads a stable identity order and reverses the complete order", () => {
    const scope = scopeFor(new PostgresAdapter(), ordered);
    const order = normalizeCursorOrder(
      scope,
      undefined,
      undefined,
      2,
      scope.rootAlias
    );
    if (!order) throw new Error("Expected a normalized cursor order.");

    expect(buildNormalizedOrderBy(scope, order)?.toStatement("$n")).toBe(
      '"t0"."id" ASC'
    );
    expect(
      reverseCursorOrder(order).map(({ field, direction, nulls }) => ({
        field,
        direction,
        nulls,
      }))
    ).toEqual([{ field: "id", direction: "desc", nulls: "first" }]);
    expect(buildNormalizedOrderBy(scope, [])).toBeUndefined();
  });

  test("refuses pagination when the model has no stable row identity", () => {
    const scope = scopeFor(new PostgresAdapter(), keyless);

    expect(() =>
      normalizeCursorOrder(
        scope,
        { label: "asc" },
        undefined,
        2,
        scope.rootAlias
      )
    ).toThrow("Paginated scalar ordering requires a primary model identifier");
  });
});

describe("coverage low value", () => {
  test("fails closed on malformed post-validation scalar order state", () => {
    const scope = scopeFor(new PostgresAdapter(), ordered);

    expect(() =>
      normalizeCursorOrder(
        scope,
        { rank: { sort: "sideways" } },
        [{ fieldName: "id", value: "cursor-id" }],
        2,
        scope.rootAlias
      )
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
    expect(() =>
      normalizeCursorOrder(
        scope,
        { rank: { sort: "asc", nulls: "middle" } },
        [{ fieldName: "id", value: "cursor-id" }],
        2,
        scope.rootAlias
      )
    ).toThrow("Cursor pagination supports direct scalar sort directions only");
  });
});
