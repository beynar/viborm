import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { push } from "@migrations";
import { s } from "@schema";
import { Decimal } from "@src/index";
import { defineContract } from "@tests/contracts/contract";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The decimal contract, exercised against a real database.
 *
 * Every value here is chosen to DISCRIMINATE. A test that passes with a
 * lexicographic comparison, or with a value that happens to fit in a double,
 * proves nothing — so the fixtures are:
 *
 *  - "9" vs "10"        — numeric order disagrees with byte order
 *  - "0.10" vs "0.9"    — same, one digit further in
 *  - the domain's two largest values, one unit in the last place apart — they
 *    are the SAME IEEE-754 double, so any float path collapses them
 *  - exact HALVES in both signs — the only inputs that can tell round-half-even
 *    apart from half-up, half-down and half-away-from-zero
 *
 * DESCRIPTOR-PARAMETERIZED. The domain arrives from the registration rather
 * than being fixed here, because the three provider families do not admit the
 * same one: SQLite's limit is `precision + scale <= 18` and the shared body
 * has to stay inside every provider's intersection. Wide-precision cases belong
 * in a PostgreSQL/MySQL-only arm, not here.
 *
 * There is no refusal arm any more. SQLite stores the unscaled integer
 * coefficient, so ordering, aggregation and arithmetic are exact there too, and
 * every assertion below runs on every provider.
 */

export interface DecimalExactnessOptions {
  driverName: string;
  createDriver: () => AnyDriver;
  /**
   * The domain the model under test declares.
   *
   * `scale: 2` is required by the rounding cases: a tie is a value whose first
   * discarded digit is exactly five with nothing after it, and which values
   * those are is a function of the scale. A registration that changes it fails
   * on the guard below rather than quietly skipping the rounding contract.
   */
  descriptor: { precision: number; scale: number };
}

/**
 * One decimal update operation, spelled as the exact-one union spells it: a
 * SINGLE key. Typing the helper this way rather than as a record is what keeps
 * the tests inside the public contract — a record would type-check a two-key
 * payload the schema refuses.
 */
type DecimalOperation =
  | { set: string }
  | { increment: string }
  | { decrement: string }
  | { multiply: string }
  | { divide: string };

/** The pre-I/O refusal for a zero divisor, and for an over-fine operand. */
const DIVIDE_BY_ZERO_REFUSAL = /divide decimal field 'amount' by zero/;
const EXCESS_SCALE_REFUSAL = /fractional digit/;

/** The logical value of an unscaled coefficient, spelled canonically. */
const atScale = (coefficient: bigint, scale: number): string => {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const literal =
    scale === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  const canonical = canonicalizeDecimal(literal);
  if (canonical === undefined) throw new Error(`not a decimal: ${literal}`);
  return negative ? `-${canonical}` : canonical;
};

/** The largest coefficient the descriptor admits: `10^precision - 1`. */
const maxCoefficient = (precision: number): bigint =>
  10n ** BigInt(precision) - 1n;

/**
 * Decimal results are `Decimal` INSTANCES, so assertions compare canonical
 * text. Reducing through the codec is what makes "the same number" the
 * question: a physical coefficient string reduces to itself and therefore
 * fails against a logical expectation instead of being smoothed over.
 */
const canonical = (value: unknown): string | undefined =>
  value === null || value === undefined
    ? undefined
    : canonicalizeDecimal(value);

export function runDecimalExactnessBehavior({
  driverName,
  createDriver,
  descriptor,
}: DecimalExactnessOptions) {
  const { precision, scale } = descriptor;
  const ledger = s
    .model({
      id: s.string().id(),
      amount: s.decimal({ precision, scale }),
      optional: s.decimal({ precision, scale }).nullable(),
      amounts: s.decimal({ precision, scale }).array().nullable(),
      bucket: s.string(),
    })
    .map("decimal_exactness_ledger");

  const schema = { ledger };
  type DecimalClientConfig = VibORMConfig & {
    schema: typeof schema;
    driver: AnyDriver;
  };
  type DecimalClient = VibORMClient<DecimalClientConfig>;

  /** The domain's two largest values, one unit in the last place apart. */
  const MAX = atScale(maxCoefficient(precision), scale);
  const NEAR_MAX = atScale(maxCoefficient(precision) - 1n, scale);

  const ROWS = [
    { id: "r-nine", amount: "9", bucket: "alpha" },
    // Orders BEFORE "9" lexicographically and after it numerically.
    { id: "r-ten", amount: "10", bucket: "alpha" },
    { id: "r-nineandhalf", amount: "9.5", bucket: "beta" },
    // Canonicalizes to 0.1; sorts after "0.9" as text and before it as a value.
    { id: "r-tenth", amount: "0.10", bucket: "gamma" },
    { id: "r-ninetenths", amount: "0.9", bucket: "gamma" },
    { id: "r-near-max", amount: NEAR_MAX, bucket: "gamma" },
    { id: "r-max", amount: MAX, bucket: "gamma" },
    { id: "r-neg", amount: "-2.5", bucket: "gamma" },
  ] as const;

  /**
   * Ascending by VALUE. Byte order would give
   * -2.5, 0.1, 0.9, 10, 9, 9.5, 9999…98, 9999…99 — the two orders disagree
   * from the fourth row on, so any window that reaches it discriminates.
   */
  const ASCENDING_BY_VALUE = [
    "r-neg",
    "r-tenth",
    "r-ninetenths",
    "r-nine",
    "r-nineandhalf",
    "r-ten",
    "r-near-max",
    "r-max",
  ] as const;

  describe(`${driverName} decimal exactness`, () => {
    let client: DecimalClient | undefined;

    beforeEach(async () => {
      client = createClient({ schema, driver: createDriver() });
      await push(client, { force: true });
    });

    afterEach(async () => {
      if (client) {
        await client.$disconnect();
        client = undefined;
      }
    });

    const active = (): DecimalClient => {
      if (!client) throw new Error("decimal test client was not initialized");
      return client;
    };

    const seed = async (): Promise<void> => {
      for (const row of ROWS) {
        await active().ledger.create({ data: { ...row, optional: null } });
      }
    };

    const amountOf = async (id: string): Promise<string | undefined> =>
      canonical((await active().ledger.findUnique({ where: { id } }))?.amount);

    /** One row carrying `start`, then one arithmetic update on it. */
    const arithmetic = async (
      start: string,
      data: DecimalOperation
    ): Promise<string | undefined> => {
      await active().ledger.create({
        data: { id: "r-math", amount: start, optional: null, bucket: "alpha" },
      });
      await active().ledger.update({
        where: { id: "r-math" },
        data: { amount: data },
      });
      return amountOf("r-math");
    };

    // =======================================================================
    // STORAGE
    // =======================================================================

    test("round-trips every value in the domain exactly", async () => {
      await seed();

      const rows = await active().ledger.findMany();
      const byId = new Map(rows.map((row) => [row.id, canonical(row.amount)]));

      expect(byId.get("r-max")).toBe(MAX);
      expect(byId.get("r-near-max")).toBe(NEAR_MAX);
      expect(byId.get("r-neg")).toBe("-2.5");
      expect(byId.get("r-nine")).toBe("9");
      // Canonicalized on the way in: "0.10" and "0.1" are the same number.
      expect(byId.get("r-tenth")).toBe("0.1");
    });

    test("callback transactions materialize fresh Decimal scalar and list results", async () => {
      await active().ledger.create({
        data: {
          id: "r-callback",
          amount: MAX,
          optional: null,
          amounts: [MAX, "-0.03"],
          bucket: "transaction",
        },
      });

      const [first, second] = await active().$transaction(async (tx) => {
        const firstRead = await tx.ledger.findUnique({
          where: { id: "r-callback" },
        });
        const secondRead = await tx.ledger.findUnique({
          where: { id: "r-callback" },
        });
        return [firstRead, secondRead];
      });
      if (!(first && second && first.amounts && second.amounts)) {
        throw new Error(
          "the callback transaction did not return its decimal row"
        );
      }

      expect(first.amount).toBeInstanceOf(Decimal);
      expect(first.amount.eq(MAX)).toBe(true);
      expect(first.amounts).toHaveLength(2);
      expect(first.amounts[0]).toBeInstanceOf(Decimal);
      expect(first.amounts[0]?.eq(MAX)).toBe(true);
      expect(first.amounts[1]).toBeInstanceOf(Decimal);
      expect(first.amounts[1]?.eq("-0.03")).toBe(true);
      expect(first.amount).not.toBe(second.amount);
      expect(first.amounts[0]).not.toBe(second.amounts[0]);
      expect(first.amounts[1]).not.toBe(second.amounts[1]);
    });

    test("array transactions materialize fresh Decimal scalar and list results", async () => {
      await active().ledger.create({
        data: {
          id: "r-array",
          amount: "1",
          optional: null,
          amounts: ["1", "2"],
          bucket: "transaction",
        },
      });

      const [updated, selected] = await active().$transaction([
        active().ledger.update({
          where: { id: "r-array" },
          data: {
            amount: { set: NEAR_MAX },
            amounts: { set: [NEAR_MAX, "-0.03"] },
          },
        }),
        active().ledger.findUnique({ where: { id: "r-array" } }),
      ]);
      if (!(selected && updated.amounts && selected.amounts)) {
        throw new Error("the array transaction did not return its decimal row");
      }

      expect(updated.amount).toBeInstanceOf(Decimal);
      expect(updated.amount.eq(NEAR_MAX)).toBe(true);
      expect(updated.amounts[0]).toBeInstanceOf(Decimal);
      expect(updated.amounts[0]?.eq(NEAR_MAX)).toBe(true);
      expect(updated.amounts[1]).toBeInstanceOf(Decimal);
      expect(updated.amounts[1]?.eq("-0.03")).toBe(true);
      expect(selected.amount).toBeInstanceOf(Decimal);
      expect(selected.amount.eq(NEAR_MAX)).toBe(true);
      expect(selected.amounts[0]).toBeInstanceOf(Decimal);
      expect(selected.amounts[0]?.eq(NEAR_MAX)).toBe(true);
      expect(selected.amounts[1]).toBeInstanceOf(Decimal);
      expect(selected.amounts[1]?.eq("-0.03")).toBe(true);
      expect(updated.amount).not.toBe(selected.amount);
      expect(updated.amounts[0]).not.toBe(selected.amounts[0]);
      expect(updated.amounts[1]).not.toBe(selected.amounts[1]);
    });

    test("a nullable decimal stores and reads NULL, not zero", async () => {
      await seed();

      const row = await active().ledger.findUnique({ where: { id: "r-nine" } });
      expect(row?.optional).toBeNull();

      const nulls = await active().ledger.findMany({
        where: { optional: null },
      });
      expect(nulls).toHaveLength(ROWS.length);
    });

    // =======================================================================
    // COMPARISON AND ORDER
    // =======================================================================

    test("equals matches on value, not on spelling", async () => {
      await seed();

      for (const spelling of ["0.1", "0.10", "0.100", "+0.1"]) {
        const found = await active().ledger.findMany({
          where: { amount: spelling },
        });
        expect(found.map((row) => row.id)).toEqual(["r-tenth"]);
      }
    });

    test("equals distinguishes the two values a double cannot", async () => {
      await seed();

      const hit = await active().ledger.findMany({ where: { amount: MAX } });
      expect(hit.map((row) => row.id)).toEqual(["r-max"]);

      const neighbour = await active().ledger.findMany({
        where: { amount: NEAR_MAX },
      });
      expect(neighbour.map((row) => row.id)).toEqual(["r-near-max"]);
    });

    test("in / notIn compare numerically", async () => {
      await seed();

      const inList = await active().ledger.findMany({
        where: { amount: { in: ["0.100", MAX] } },
        select: { id: true },
      });
      expect(inList.map((row) => row.id).sort()).toEqual(["r-max", "r-tenth"]);
    });

    test("gt/lt compare numerically, not lexicographically", async () => {
      await seed();

      // The discriminating pair: "9" > "10" as text, 9 < 10 as numbers.
      const overNine = await active().ledger.findMany({
        where: { amount: { gt: "9" } },
        select: { id: true },
      });
      expect(overNine.map((row) => row.id).sort()).toEqual([
        "r-max",
        "r-near-max",
        "r-nineandhalf",
        "r-ten",
      ]);

      // One unit in the last place apart, and the same double.
      const overNearMax = await active().ledger.findMany({
        where: { amount: { gt: NEAR_MAX } },
        select: { id: true },
      });
      expect(overNearMax.map((row) => row.id)).toEqual(["r-max"]);
    });

    test("orderBy sorts numerically, windowed and not", async () => {
      await seed();

      const all = await active().ledger.findMany({
        orderBy: { amount: "asc" },
        select: { id: true },
      });
      expect(all.map((row) => row.id)).toEqual([...ASCENDING_BY_VALUE]);

      // The ordinary spelling of a sorted list — the one that used to escape
      // the gate entirely and come back in byte order.
      const firstFive = await active().ledger.findMany({
        orderBy: { amount: "asc" },
        take: 5,
        select: { id: true },
      });
      expect(firstFive.map((row) => row.id)).toEqual(
        ASCENDING_BY_VALUE.slice(0, 5)
      );

      const secondLargest = await active().ledger.findFirst({
        orderBy: { amount: "desc" },
        skip: 1,
        select: { id: true },
      });
      expect(secondLargest?.id).toBe("r-near-max");

      const page = await active().ledger.findMany({
        orderBy: { amount: "asc" },
        cursor: { id: "r-nine" },
        take: 3,
        select: { id: true },
      });
      expect(page.map((row) => row.id)).toEqual([
        "r-nine",
        "r-nineandhalf",
        "r-ten",
      ]);
    });

    // =======================================================================
    // AGGREGATES
    // =======================================================================

    test("_min/_max/_sum/_avg are exact, and _sum may exceed the precision", async () => {
      await seed();

      const result = await active().ledger.aggregate({
        _min: { amount: true },
        _max: { amount: true },
        _sum: { amount: true },
        _avg: { amount: true },
      });

      expect(canonical(result._min.amount)).toBe("-2.5");
      expect(canonical(result._max.amount)).toBe(MAX);
      // MAX + NEAR_MAX alone needs one digit more than the column holds, and
      // the answer must not be rejected for that.
      const total = ROWS.reduce(
        (sum, row) => sum + BigInt(canonicalToCoefficient(row.amount, scale)),
        0n
      );
      expect(canonical(result._sum.amount)).toBe(atScale(total, scale));
      // The average is quantized back to the field's scale half-to-even.
      expect(canonical(result._avg.amount)).toBe(
        atScale(halfEven(total, BigInt(ROWS.length)), scale)
      );
    });

    test("_avg of an all-null column is NULL, not zero and not an error", async () => {
      await seed();

      const result = await active().ledger.aggregate({
        _avg: { optional: true },
        _sum: { optional: true },
      });
      expect(result._avg.optional).toBeNull();
      expect(result._sum.optional).toBeNull();
    });

    test("_avg rounds exact ties to the even neighbour in both signs", async () => {
      if (scale !== 2)
        throw new Error("the average tie fixtures assume scale 2");

      const cases = [
        { values: ["0.02", "0.03"], expected: "0.02" },
        { values: ["0.03", "0.04"], expected: "0.04" },
        { values: ["-0.02", "-0.03"], expected: "-0.02" },
        { values: ["-0.03", "-0.04"], expected: "-0.04" },
      ] as const;

      for (const [caseIndex, averageCase] of cases.entries()) {
        await active().ledger.deleteMany({});
        await active().ledger.createMany({
          data: averageCase.values.map((amount, rowIndex) => ({
            id: `avg-${caseIndex}-${rowIndex}`,
            amount,
            optional: null,
            bucket: "average",
          })),
        });

        const result = await active().ledger.aggregate({
          _avg: { amount: true },
        });
        expect(canonical(result._avg.amount)).toBe(averageCase.expected);
      }
    });

    test("groupBy orders groups and filters them on exact aggregates", async () => {
      await seed();

      // MAX over text would rank alpha ("9") below beta ("9.5"); the values
      // say alpha (10) is above it.
      const byMax = await active().ledger.groupBy({
        by: ["bucket"],
        orderBy: { _max: { amount: "desc" } },
        _count: true,
      });
      expect(byMax.map((group) => group.bucket)).toEqual([
        "gamma",
        "alpha",
        "beta",
      ]);

      // alpha's MIN is 9 numerically and "10" by bytes; only beta's 9.5 clears
      // the bound, and a byte-order MIN would wrongly add alpha.
      const minOverBound = await active().ledger.groupBy({
        by: ["bucket"],
        having: { amount: { _min: { gt: "9.2" } } },
        _count: true,
      });
      expect(minOverBound.map((group) => group.bucket)).toEqual(["beta"]);
    });

    test("groupBy compares a widened _sum beyond the field precision", async () => {
      await seed();
      const widenedBound = atScale(10n ** BigInt(precision), scale);
      const gammaTotal = ROWS.filter((row) => row.bucket === "gamma").reduce(
        (sum, row) => sum + BigInt(canonicalToCoefficient(row.amount, scale)),
        0n
      );

      const groups = await active().ledger.groupBy({
        by: ["bucket"],
        having: { amount: { _sum: { gt: widenedBound } } },
        _sum: { amount: true },
      });

      expect(groups.map((group) => group.bucket)).toEqual(["gamma"]);
      expect(groups[0]?._sum.amount).toBeInstanceOf(Decimal);
      expect(canonical(groups[0]?._sum.amount)).toBe(
        atScale(gammaTotal, scale)
      );
    });

    // =======================================================================
    // ARITHMETIC — the half-even rule, in both signs
    // =======================================================================

    test("increment and decrement are exact and never round", async () => {
      expect(await arithmetic("0.1", { increment: "0.2" })).toBe("0.3");
      await active().ledger.update({
        where: { id: "r-math" },
        data: { amount: { decrement: "0.3" } },
      });
      expect(await amountOf("r-math")).toBe("0");
    });

    test("the precision-plus-scale edge keeps an in-range 10^18 intermediate exact", async () => {
      if (precision + scale !== 18) {
        throw new Error(
          "the intermediate-edge fixture requires precision + scale 18"
        );
      }
      await active().ledger.createMany({
        data: [
          { id: "edge-multiply", amount: MAX, optional: null, bucket: "edge" },
          { id: "edge-divide", amount: MAX, optional: null, bucket: "edge" },
        ],
      });

      // At (16,2), MAX's coefficient times the scale factor is
      // 999999999999999900: two paths whose intermediate sits just below the
      // 10^18 provider guard while their mathematical result remains in-range.
      await active().ledger.update({
        where: { id: "edge-multiply" },
        data: { amount: { multiply: "1" } },
      });
      await active().ledger.update({
        where: { id: "edge-divide" },
        data: { amount: { divide: "1" } },
      });

      expect(await amountOf("edge-multiply")).toBe(MAX);
      expect(await amountOf("edge-divide")).toBe(MAX);
    });

    test("multiply rounds an exact POSITIVE tie to the EVEN neighbour", async () => {
      if (scale !== 2) throw new Error("the tie fixtures assume scale 2");
      // 0.05 x 0.5 = 0.025 — dead on the half. Half-up answers 0.03.
      expect(await arithmetic(atScale(5n, scale), { multiply: "0.5" })).toBe(
        atScale(2n, scale)
      );
    });

    test("multiply rounds an exact POSITIVE tie AWAY when the neighbour is odd", async () => {
      // 0.15 x 0.5 = 0.075 — dead on the half, and 0.07 is odd, so the even
      // neighbour is 0.08. Half-down answers 0.07.
      expect(await arithmetic(atScale(15n, scale), { multiply: "0.5" })).toBe(
        atScale(8n, scale)
      );
    });

    test("multiply rounds an exact NEGATIVE tie to the EVEN neighbour", async () => {
      // -0.05 x 0.5 = -0.025. Half-away-from-zero answers -0.03.
      expect(await arithmetic(atScale(-5n, scale), { multiply: "0.5" })).toBe(
        atScale(-2n, scale)
      );
      await active().ledger.delete({ where: { id: "r-math" } });
      // -0.15 x 0.5 = -0.075, whose even neighbour is -0.08.
      expect(await arithmetic(atScale(-15n, scale), { multiply: "0.5" })).toBe(
        atScale(-8n, scale)
      );
    });

    test("a rounded tie CARRIES across the whole value", async () => {
      // 1.99 x 0.5 = 0.995: the tie rounds away from zero (0.99 is odd) and the
      // carry propagates through both nines into 1.00.
      expect(await arithmetic(atScale(199n, scale), { multiply: "0.5" })).toBe(
        atScale(100n, scale)
      );
    });

    test("divide rounds by the same rule, in both signs", async () => {
      // 1 / 8 = 0.125 — a tie whose even neighbour is 0.12.
      expect(await arithmetic("1", { divide: "8" })).toBe(atScale(12n, scale));
      await active().ledger.delete({ where: { id: "r-math" } });
      // 3 / 8 = 0.375 — a tie whose even neighbour is 0.38.
      expect(await arithmetic("3", { divide: "8" })).toBe(atScale(38n, scale));
      await active().ledger.delete({ where: { id: "r-math" } });
      // -1 / 8 = -0.125 — the negative of the first, and NOT -0.13.
      expect(await arithmetic("-1", { divide: "8" })).toBe(
        atScale(-12n, scale)
      );
      await active().ledger.delete({ where: { id: "r-math" } });
      // A non-terminating quotient still lands on the nearest representable.
      expect(await arithmetic("2", { divide: "3" })).toBe(atScale(67n, scale));
    });

    test("dividing by a NEGATIVE operand keeps the quotient's sign", async () => {
      expect(await arithmetic("1", { divide: "-8" })).toBe(
        atScale(-12n, scale)
      );
    });

    test("arithmetic on a NULL column stays NULL", async () => {
      await active().ledger.create({
        data: { id: "r-null", amount: "1", optional: null, bucket: "alpha" },
      });
      await active().ledger.update({
        where: { id: "r-null" },
        data: { optional: { multiply: "3" } },
      });
      const row = await active().ledger.findUnique({ where: { id: "r-null" } });
      expect(row?.optional).toBeNull();
    });

    // =======================================================================
    // FAILURE — before I/O where it is knowable, atomically where it is not
    // =======================================================================

    test("division by zero fails BEFORE any statement is issued", async () => {
      await active().ledger.create({
        data: { id: "r-zero", amount: "1", optional: null, bucket: "alpha" },
      });

      await expect(
        active().ledger.update({
          where: { id: "r-zero" },
          data: { amount: { divide: "0" } },
        })
      ).rejects.toThrow(DIVIDE_BY_ZERO_REFUSAL);

      // The row is untouched: nothing reached the database to touch it.
      expect(await amountOf("r-zero")).toBe("1");
    });

    test("a result past the field's precision fails and leaves the row alone", async () => {
      await active().ledger.create({
        data: { id: "r-over", amount: MAX, optional: null, bucket: "alpha" },
      });

      await expect(
        active().ledger.update({
          where: { id: "r-over" },
          data: { amount: { increment: MAX } },
        })
      ).rejects.toThrow();

      expect(await amountOf("r-over")).toBe(MAX);
    });

    test("an INTERMEDIATE past the safe range fails; it never answers through a float", async () => {
      await active().ledger.create({
        data: { id: "r-wide", amount: MAX, optional: null, bucket: "alpha" },
      });

      // MAX x MAX needs twice the domain's digits. On a coefficient dialect the
      // product would leave int64 and SQLite would silently make the whole
      // expression REAL, so the guarded arm routes it to a coefficient the
      // column's range check refuses instead of evaluating it.
      await expect(
        active().ledger.update({
          where: { id: "r-wide" },
          data: { amount: { multiply: MAX } },
        })
      ).rejects.toThrow();

      expect(await amountOf("r-wide")).toBe(MAX);
    });

    test("an operand finer than the field's scale is refused, never rounded", async () => {
      await active().ledger.create({
        data: { id: "r-fine", amount: "1", optional: null, bucket: "alpha" },
      });

      for (const operation of [
        { increment: "0.005" },
        { decrement: "0.005" },
        { multiply: "0.005" },
        { divide: "0.005" },
        { set: "0.005" },
      ]) {
        await expect(
          active().ledger.update({
            where: { id: "r-fine" },
            data: { amount: operation },
          })
        ).rejects.toThrow(EXCESS_SCALE_REFUSAL);
      }

      expect(await amountOf("r-fine")).toBe("1");
    });
  });
}

/** The unscaled coefficient of a canonical logical value, as a digit string. */
function canonicalToCoefficient(value: string, scale: number): string {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [integer = "", fraction = ""] = unsigned.split(".");
  const digits = `${integer}${fraction.padEnd(scale, "0")}`;
  return negative ? `-${digits}` : digits;
}

/**
 * `n / d` rounded half to even, in the same three integer facts the SQL uses —
 * written independently here so the expectation is not the implementation.
 */
function halfEven(n: bigint, d: bigint): bigint {
  const quotient = n / d;
  const remainder = n % d;
  const twice = (remainder < 0n ? -remainder : remainder) * 2n;
  const away = twice > d || (twice === d && quotient % 2n !== 0n);
  if (!away) return quotient;
  return n < 0n ? quotient - 1n : quotient + 1n;
}

export const decimalExactnessContract = defineContract({
  id: "drivers.decimal-exactness",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution", "transactions"],
  register: runDecimalExactnessBehavior,
});
