/**
 * Provider-backed aggregate RESULT TYPE, pinned against the RESULT PARSER.
 *
 * `result-aggregate-parser.ts` decides the runtime spelling of every aggregate
 * column: `_sum` / `_min` / `_max` are `typed` — decoded through the FIELD'S OWN
 * scalar decoder — while `_avg` widens to a JS number, except over a decimal,
 * whose average the database computes exactly and returns as text.
 *
 * `_sum` used to be typed `number` for every non-decimal numeric, so
 * `agg._sum.big` was declared `number | null` and returned a `bigint`:
 * arithmetic threw "Cannot mix BigInt and other types", `JSON.stringify` threw,
 * `.toFixed()` threw, and — the silent one — `agg._sum.big === 150` was always
 * false under bigint-vs-number strict equality.
 *
 * This file is the matrix: every numeric-capable scalar (int, number, bigint,
 * decimal) x (_sum, _avg, _min, _max), on `aggregate()` AND on `groupBy()`,
 * plus a live PGlite probe that asserts `typeof` agrees with the static claim
 * for the two scalars the widening lie covered up.
 */

import type { OperationResult } from "@client/types";
import { createClient as PGliteCreateClient } from "@drivers/pglite";

import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Decimal from "decimal.js";
import {
  afterAll,
  beforeAll,
  describe,
  expect,
  expectTypeOf,
  test,
} from "vitest";

const ledger = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    qty: s.int(),
    ratio: s.number(),
    big: s.bigInt(),
    amount: s.decimal({ precision: 40, scale: 30 }),
  })
  .map("aggregate_result_type_ledger");

type LedgerModel = typeof ledger;

const schema = { ledger };

type Aggregate<Args> = OperationResult<"aggregate", LedgerModel, Args>;
type GroupBy<Args> = OperationResult<"groupBy", LedgerModel, Args>[number];

// =============================================================================
// THE MATRIX — aggregate()
// =============================================================================

describe("aggregate() result types follow the field's own decoder", () => {
  test("_sum is spelled like the column, one row per numeric scalar", () => {
    type Result = Aggregate<{
      _sum: { qty: true; ratio: true; big: true; amount: true };
    }>;

    expectTypeOf<Result["_sum"]["qty"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_sum"]["ratio"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_sum"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Result["_sum"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });

  test("_avg widens to a number — decimal excepted", () => {
    type Result = Aggregate<{
      _avg: { qty: true; ratio: true; big: true; amount: true };
    }>;

    expectTypeOf<Result["_avg"]["qty"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_avg"]["ratio"]>().toEqualTypeOf<number | null>();
    // A bigint AVERAGE really does widen: `_avg` is not `typed` in the parser.
    expectTypeOf<Result["_avg"]["big"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_avg"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });

  test("_min is spelled like the column", () => {
    type Result = Aggregate<{
      _min: { qty: true; ratio: true; big: true; amount: true };
    }>;

    expectTypeOf<Result["_min"]["qty"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_min"]["ratio"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_min"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Result["_min"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });

  test("_max is spelled like the column", () => {
    type Result = Aggregate<{
      _max: { qty: true; ratio: true; big: true; amount: true };
    }>;

    expectTypeOf<Result["_max"]["qty"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_max"]["ratio"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Result["_max"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Result["_max"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });

  test("_count stays a plain number for every scalar", () => {
    type Result = Aggregate<{ _count: { big: true; amount: true } }>;

    expectTypeOf<Result["_count"]["big"]>().toEqualTypeOf<number>();
    expectTypeOf<Result["_count"]["amount"]>().toEqualTypeOf<number>();
  });
});

// =============================================================================
// THE MATRIX — groupBy()
// =============================================================================

describe("groupBy() carries the same aggregate spellings", () => {
  test("_sum per scalar, beside the grouped-by key", () => {
    type Row = GroupBy<{
      by: ["bucket"];
      _sum: { qty: true; ratio: true; big: true; amount: true };
    }>;

    expectTypeOf<Row["bucket"]>().toEqualTypeOf<string>();
    expectTypeOf<Row["_sum"]["qty"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Row["_sum"]["ratio"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Row["_sum"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Row["_sum"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });

  test("_avg / _min / _max per scalar", () => {
    type Row = GroupBy<{
      by: ["bucket"];
      _avg: { big: true; amount: true };
      _min: { big: true; amount: true };
      _max: { big: true; amount: true };
    }>;

    expectTypeOf<Row["_avg"]["big"]>().toEqualTypeOf<number | null>();
    expectTypeOf<Row["_avg"]["amount"]>().toEqualTypeOf<Decimal | null>();
    expectTypeOf<Row["_min"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Row["_min"]["amount"]>().toEqualTypeOf<Decimal | null>();
    expectTypeOf<Row["_max"]["big"]>().toEqualTypeOf<bigint | null>();
    expectTypeOf<Row["_max"]["amount"]>().toEqualTypeOf<Decimal | null>();
  });
});

// =============================================================================
// THE LIVE PROBE — typeof agrees with the static claim
// =============================================================================

let client: Awaited<
  ReturnType<
    typeof PGliteCreateClient<typeof schema, { schema: typeof schema }>
  >
>;
let pglite: import("@electric-sql/pglite").PGlite;

beforeAll(async () => {
  const { PGlite } = await import("@electric-sql/pglite");
  pglite = new PGlite();
  client = await PGliteCreateClient({ schema, client: pglite });
  await syncLiveSchema(client);
  await client.ledger.createMany({
    data: [
      {
        id: "a",
        bucket: "b1",
        qty: 2,
        ratio: 1.5,
        // Past 2^53: a `number` declaration could not carry the sum.
        big: 9007199254740993n,
        amount: "0.100000000000000000000000000001",
      },
      {
        id: "b",
        bucket: "b1",
        qty: 3,
        ratio: 2.5,
        big: 2n,
        amount: "0.2",
      },
    ],
  });
});

afterAll(async () => {
  try {
    await client.$disconnect();
  } finally {
    await pglite.close();
  }
});

describe("the runtime agrees with the declaration", () => {
  test("aggregate: _sum of a bigint IS a bigint, of a decimal IS a Decimal", async () => {
    const agg = await client.ledger.aggregate({
      _sum: { qty: true, ratio: true, big: true, amount: true },
      _avg: { big: true, amount: true },
      _min: { big: true },
      _max: { big: true },
    });

    // The declaration, restated as a value assignment: this line stops
    // compiling the moment the type widens back to `number | null`.
    const summedBig: bigint | null = agg._sum.big;
    const summedAmount: Decimal | null = agg._sum.amount;
    const averagedBig: number | null = agg._avg.big;
    const averagedAmount: Decimal | null = agg._avg.amount;

    expect(typeof summedBig).toBe("bigint");
    expect(summedBig).toBe(9007199254740995n);
    expect(summedAmount).toBeInstanceOf(Decimal);
    // The SUM is precision-widened and scale-preserving: neither operand fits a
    // double, and the answer keeps every one of the field's 30 fraction digits.
    expect(summedAmount?.eq("0.300000000000000000000000000001")).toBe(true);
    expect(typeof averagedBig).toBe("number");
    expect(averagedAmount).toBeInstanceOf(Decimal);
    // The AVERAGE stays in the field domain: the exact mean of these two rows
    // needs 31 fraction digits, and the field has 30, so it is quantized to the
    // field's scale — never widened the way the sum is.
    expect(averagedAmount?.decimalPlaces()).toBeLessThanOrEqual(30);

    expect(typeof agg._sum.qty).toBe("number");
    expect(agg._sum.qty).toBe(5);
    expect(typeof agg._sum.ratio).toBe("number");
    expect(typeof agg._min.big).toBe("bigint");
    expect(typeof agg._max.big).toBe("bigint");

    // The lie's quietest consequence: a comparison written against the old
    // `number` declaration is false for a value that IS the sum.
    expect(agg._sum.big === 9007199254740995n).toBe(true);
  });

  test("groupBy: the same spellings, per group", async () => {
    const [group] = await client.ledger.groupBy({
      by: ["bucket"],
      _sum: { big: true, amount: true },
    });

    if (!group) {
      throw new Error("expected one group");
    }

    const summedBig: bigint | null = group._sum.big;
    const summedAmount: Decimal | null = group._sum.amount;

    expect(group.bucket).toBe("b1");
    expect(typeof summedBig).toBe("bigint");
    expect(summedBig).toBe(9007199254740995n);
    expect(summedAmount).toBeInstanceOf(Decimal);
  });
});
