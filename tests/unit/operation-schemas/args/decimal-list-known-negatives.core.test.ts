import { s } from "@schema";
import { createSchemaRegistry, parse } from "@validation";
import { describe, expect, test } from "vitest";

const entry = s.model({
  id: s.string().id(),
  amount: s.decimal({ precision: 10, scale: 2 }),
  amounts: s.decimal({ precision: 10, scale: 2 }).array(),
  counts: s.int().array(),
});

const registry = createSchemaRegistry({ entry });
const schemas = registry.proxy.entry;

const messageOf = (issues: readonly { message: string }[] | undefined) =>
  issues?.[0]?.message;

describe("decimal-list retained negative operation keys", () => {
  for (const [operation, operand] of Object.entries({
    in: ["1"],
    notIn: ["1"],
    lt: "1",
    lte: "1",
    gt: "1",
    gte: "1",
  })) {
    test(`filter ${operation} reaches the named refusal`, () => {
      const result = parse(schemas.core.where, {
        amounts: { [operation]: operand },
      });

      expect(messageOf(result.issues)).toContain(
        `A decimal list filter does not support '${operation}'.`
      );
    });
  }

  test("recursive not retains the same closed filter surface", () => {
    const result = parse(schemas.core.where, {
      amounts: { not: { gt: "1" } },
    });

    expect(messageOf(result.issues)).toContain(
      "A decimal list filter does not support 'gt'."
    );
  });

  for (const operation of [
    "increment",
    "decrement",
    "multiply",
    "divide",
  ] as const) {
    test(`update ${operation} reaches the named refusal`, () => {
      const result = parse(schemas.core.update, {
        amounts: { [operation]: "1" },
      });

      expect(messageOf(result.issues)).toContain(
        `A decimal list update does not support '${operation}'.`
      );
    });
  }

  for (const aggregate of ["_avg", "_sum", "_min", "_max"] as const) {
    for (const field of ["amounts", "counts"] as const) {
      test(`having ${aggregate} retains ${field} as never`, () => {
        const result = parse(schemas.args.groupBy, {
          by: ["id"],
          having: {
            [field]: {
              _count: { gt: 0 },
              [aggregate]: { gt: 1 },
            },
          },
        });

        expect(messageOf(result.issues)).toContain(
          `A list cannot use '${aggregate}' in having; only '_count' is supported.`
        );
      });

      test(`having ${aggregate} is refused beside ${field}.has`, () => {
        const result = parse(schemas.args.groupBy, {
          by: ["id"],
          having: {
            [field]: {
              has: 1,
              [aggregate]: { gt: 1 },
            },
          },
        });

        expect(messageOf(result.issues)).toContain(
          `A list cannot use '${aggregate}' in having; only '_count' is supported.`
        );
      });

      test(`aggregate ${aggregate} retains ${field} as never`, () => {
        const result = parse(schemas.args.aggregate, {
          [aggregate]: { amount: true, [field]: true },
        });

        expect(messageOf(result.issues)).toContain(
          `A list cannot be projected by '${aggregate}'; only '_count' is supported.`
        );
      });

      test(`groupBy projection ${aggregate} retains ${field} as never`, () => {
        const result = parse(schemas.args.groupBy, {
          by: ["id"],
          [aggregate]: { amount: true, [field]: true },
        });

        expect(messageOf(result.issues)).toContain(
          `A list cannot be projected by '${aggregate}'; only '_count' is supported.`
        );
      });

      test(`groupBy orderBy ${aggregate} retains ${field} as never`, () => {
        const result = parse(schemas.args.groupBy, {
          by: ["id"],
          orderBy: {
            [aggregate]: { amount: "asc", [field]: "desc" },
          },
        });

        expect(messageOf(result.issues)).toContain(
          `A list cannot be ordered by '${aggregate}'; only '_count' is supported.`
        );
      });
    }
  }

  test("groupBy aggregate count still orders by a decimal list", () => {
    const result = parse(schemas.args.groupBy, {
      by: ["id"],
      orderBy: { _count: { amounts: "asc", counts: "desc" } },
    });

    expect(result.issues).toBeUndefined();
  });

  test("strict whereUnique retains decimal-list keys without making them identities", () => {
    expect(Object.keys(schemas.core.whereUnique.entries)).toContain("amounts");
    expect(schemas.core.whereUnique.options.requiresOneOf).toEqual([["id"]]);

    const result = parse(schemas.core.whereUnique, {
      id: "entry",
      amounts: [],
    });
    expect(messageOf(result.issues)).toBe(
      "A decimal list cannot be used as a unique selector or cursor."
    );
  });

  test("extended whereUnique keeps decimal-list equality as a predicate", () => {
    const result = parse(schemas.core.whereUniqueExtended, {
      id: "entry",
      amounts: { has: "1" },
    });

    expect(result.issues).toBeUndefined();
  });
});
