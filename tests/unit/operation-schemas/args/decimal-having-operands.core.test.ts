/**
 * `having` operands of a DECIMAL aggregate are decimals, not doubles.
 *
 * `numericFilterOps` typed and validated every aggregate operand of every
 * scalar as `v.number()`. For an int or a float that is exactly right; for a
 * decimal it puts the comparison back through 53 bits of mantissa, which is the
 * one thing the scalar exists to avoid — and it did so on the value side of a
 * comparison whose other side the database had computed exactly.
 *
 * Two domains meet here, and the split is the whole point:
 *
 *  - `_min`, `_max` and `_avg` answer INSIDE the field's own domain, so their
 *    operands are validated against the field's precision and scale.
 *  - `_sum` may legitimately answer OUTSIDE it — a million `precision: 10` rows
 *    add up wider than any one column — so its operand is held to the field's
 *    SCALE and to nothing else.
 *  - `_count` is a ROW COUNT on every scalar and keeps the numeric operand.
 */

import { s } from "@schema";
import { createSchemaRegistry, type InferInput, parse } from "@validation";
import { getHavingSchema } from "@validation/model/args/aggregate";
import v from "@validation/primitives/v";
import { describe, expect, expectTypeOf, test } from "vitest";

const MONEY = { precision: 10, scale: 2 } as const;

const ledger = s.model({
  id: s.string().id(),
  amount: s.decimal(MONEY),
  views: s.int(),
  bucket: s.string(),
});

const registry = createSchemaRegistry({ ledger });
const groupByArgs = registry.proxy.ledger.args.groupBy;

const havingIssues = (having: unknown) =>
  parse(groupByArgs, { by: ["bucket"], having }).issues;

describe("decimal having operands", () => {
  for (const aggregate of ["_min", "_max", "_avg"] as const) {
    test(`${aggregate} accepts a decimal inside the field's domain`, () => {
      expect(
        havingIssues({ amount: { [aggregate]: { gt: "12345678.90" } } })
      ).toBeUndefined();
    });

    test(`${aggregate} refuses an operand past the field's scale`, () => {
      const issues = havingIssues({
        amount: { [aggregate]: { gt: "1.005" } },
      });
      expect(issues).toBeDefined();
      expect(JSON.stringify(issues)).toContain("fractional digit");
    });

    test(`${aggregate} refuses an operand past the field's precision`, () => {
      const issues = havingIssues({
        amount: { [aggregate]: { lte: "123456789.01" } },
      });
      expect(issues).toBeDefined();
      expect(JSON.stringify(issues)).toContain("unscaled coefficient");
    });
  }

  test("_sum accepts an operand WIDER than the field's precision", () => {
    // Eleven coefficient digits against a `precision: 10` column: an answer no
    // single row can hold and many rows can.
    expect(
      havingIssues({ amount: { _sum: { gt: "999999999.99" } } })
    ).toBeUndefined();
  });

  test("_sum still refuses an operand past the field's SCALE", () => {
    // The scale is not widened: every summed value carries the field's scale,
    // so a third fractional digit names a number the column cannot produce.
    const issues = havingIssues({ amount: { _sum: { gt: "1.005" } } });
    expect(issues).toBeDefined();
    expect(JSON.stringify(issues)).toContain("fractional digit");
  });

  test("every operator position takes the decimal operand, not just gt", () => {
    expect(
      havingIssues({
        amount: {
          _max: {
            equals: null,
            in: ["1.25", "2.50"],
            notIn: ["3.75"],
            gt: "1",
            gte: "1",
            lt: "9",
            lte: "9",
            not: null,
          },
        },
      })
    ).toBeUndefined();
    expect(havingIssues({ amount: { _max: { in: ["1.005"] } } })).toBeDefined();
  });

  test("_count keeps the row-count operand on a decimal column", () => {
    expect(havingIssues({ amount: { _count: { gt: 2 } } })).toBeUndefined();
    // A row count is an integer, and the decimal domain has nothing to say
    // about it: a fractional bound is still a legal number here.
    expect(havingIssues({ amount: { _count: { gt: 2.5 } } })).toBeUndefined();
  });

  test("a NON-decimal column keeps the numeric operand untouched", () => {
    expect(havingIssues({ views: { _avg: { gt: 2.5 } } })).toBeUndefined();
    expect(havingIssues({ views: { _sum: { gt: 1000 } } })).toBeUndefined();
    expect(havingIssues({ views: { _max: { gt: "nope" } } })).toBeDefined();
  });
});

/**
 * A LIST is not a summable column, on any scalar kind.
 *
 * `_sum` and `_avg` were selected by scalar KIND alone — `["int", "number",
 * "decimal", "bigint"].includes(type)` — which admitted every numeric LIST too.
 * A `s.decimal({...}).array()` is one JSON document per row on every provider
 * that stores it at all, and there is no column-wide addition of documents to
 * ask for; the aggregate that did get offered came with the `v.number()`
 * operand this file exists to remove, on the one scalar family where a double
 * is a lossy name for the value.
 *
 * Plan 5.3: "the current aggregate/order builders must exclude list states
 * rather than sorting JSON or admitting `_sum` by scalar kind alone."
 */
describe("aggregate keys exclude list states", () => {
  const listModel = s.model({
    id: s.string().id(),
    prices: s.decimal(MONEY).array(),
    counts: s.int().array(),
    amount: s.decimal(MONEY),
    bucket: s.string(),
  });

  const listRegistry = createSchemaRegistry({ listModel });
  const listArgs = listRegistry.proxy.listModel.args;

  type ListAggregateInput = InferInput<typeof listArgs.aggregate>;
  type ListGroupByInput = InferInput<typeof listArgs.groupBy>;

  test("types: value aggregates exclude list containers", () => {
    const aggregate: ListAggregateInput = {
      _min: {
        amount: true,
        // @ts-expect-error - value aggregates exclude list containers
        prices: true,
      },
    };
    const groupBy: ListGroupByInput = {
      by: ["bucket"],
      // @ts-expect-error - aggregate ordering excludes list containers
      orderBy: {
        _max: {
          amount: "asc",
          prices: "desc",
        },
      },
      having: {
        // @ts-expect-error - a list has only the row-count aggregate
        prices: {
          _count: { gt: 1 },
          _min: { gt: 1 },
        },
      },
    };

    expectTypeOf(aggregate).toMatchTypeOf<ListAggregateInput>();
    expectTypeOf(groupBy).toMatchTypeOf<ListGroupByInput>();
  });

  const aggregateIssues = (args: unknown) =>
    parse(listArgs.aggregate, args).issues;
  const groupByIssues = (args: unknown) => parse(listArgs.groupBy, args).issues;

  for (const aggregate of ["_sum", "_avg"] as const) {
    test(`${aggregate} does not offer a decimal LIST`, () => {
      expect(aggregateIssues({ [aggregate]: { prices: true } })).toBeDefined();
      // The scalar of the same kind in the same model still answers, so this is
      // the list-ness and not the decimal-ness.
      expect(
        aggregateIssues({ [aggregate]: { amount: true } })
      ).toBeUndefined();
    });

    test(`${aggregate} does not offer an int LIST either`, () => {
      expect(aggregateIssues({ [aggregate]: { counts: true } })).toBeDefined();
    });

    test(`groupBy orderBy ${aggregate} does not offer a list`, () => {
      expect(
        groupByIssues({
          by: ["bucket"],
          orderBy: { [aggregate]: { prices: "desc" } },
        })
      ).toBeDefined();
      expect(
        groupByIssues({
          by: ["bucket"],
          orderBy: { [aggregate]: { amount: "desc" } },
        })
      ).toBeUndefined();
    });

    test(`having ${aggregate} does not offer a list`, () => {
      // `having` builds an entry for EVERY scalar rather than reading the key
      // sets, so excluding the key is not enough on its own: without the list
      // arm the operand fell through to `v.number()` here.
      expect(
        groupByIssues({
          by: ["bucket"],
          having: { prices: { [aggregate]: { gt: 1 } } },
        })
      ).toBeDefined();
    });
  }

  test("a list keeps only _count", () => {
    expect(aggregateIssues({ _count: { prices: true } })).toBeUndefined();
    expect(
      groupByIssues({
        by: ["bucket"],
        having: { prices: { _count: { gt: 1 } } },
      })
    ).toBeUndefined();

    for (const aggregate of ["_min", "_max"] as const) {
      expect(aggregateIssues({ [aggregate]: { prices: true } })).toBeDefined();
      expect(
        groupByIssues({
          by: ["bucket"],
          orderBy: { [aggregate]: { prices: "desc" } },
        })
      ).toBeDefined();
      expect(
        groupByIssues({
          by: ["bucket"],
          having: { prices: { [aggregate]: { gt: 1 } } },
        })
      ).toBeDefined();
    }
  });
});

describe("coverage low value", () => {
  test("a malformed internal list-filter shape becomes a refusal", () => {
    const model = s.model({ prices: s.decimal(MONEY).array() });
    const stringSchema = v.string();
    const malformedFilters = [
      stringSchema,
      { ...stringSchema, type: "union" },
      { ...stringSchema, type: "union", options: [stringSchema] },
      { ...stringSchema, type: "union", options: [stringSchema, null] },
      { ...stringSchema, type: "union", options: [stringSchema, {}] },
    ];

    for (const filter of malformedFilters) {
      const having = getHavingSchema(model, {
        scalars: { prices: { filter } },
      } as never);
      expect(
        parse(having, { prices: { _sum: { gt: 1 } } }).issues
      ).toBeDefined();
    }
  });
});
