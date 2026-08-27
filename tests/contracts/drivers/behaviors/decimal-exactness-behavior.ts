import { defineContract } from "@tests/contracts/contract";
import {
  createClient,
  type VibORMClient,
  type VibORMConfig,
} from "@client/client";
import type { AnyDriver } from "@drivers";
import { UnsupportedOperationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

/**
 * The decimal contract, exercised against a real database (W6-U1).
 *
 * Every value here is chosen to DISCRIMINATE. A test that passes with a
 * lexicographic comparison, or with a value that happens to fit in a double,
 * proves nothing — so the fixtures are:
 *
 *  - "9" vs "10"      — numeric order disagrees with byte order
 *  - "0.10" vs "0.9"  — same, one digit further in
 *  - 30-digit values  — past what an IEEE-754 double can represent at all
 *  - 2^53 + 1         — past where a double can name consecutive integers
 *  - 0.1 + 0.2        — the canonical float-error witness
 */

const ledger = s
  .model({
    id: s.string().id(),
    amount: s.decimal(),
    bucket: s.string(),
    note: s.string(),
  })
  .map("decimal_exactness_ledger");

const schema = { ledger };

type DecimalClientConfig = VibORMConfig & {
  schema: typeof schema;
  driver: AnyDriver;
};
type DecimalClient = VibORMClient<DecimalClientConfig>;

export interface DecimalExactnessOptions {
  driverName: string;
  createDriver: () => AnyDriver;
  /**
   * Whether the dialect has an exact decimal type (`numeric` / `DECIMAL`).
   * False on SQLite, where the ordered and derived operations are REFUSED
   * rather than answered through a double — the refusal is asserted, not
   * skipped, so the contract is pinned on that dialect too.
   */
  exactDecimal: boolean;
}

/** The refusal must name the field and point at a real alternative. */
const REFUSAL_NAMES_FIELD = /decimal field 'amount'/;
const REFUSAL_SUGGESTS_NUMBER = /s\.number\(\)/;

/**
 * Values a double cannot hold, and values whose order byte-order gets wrong.
 *
 * `bucket` exists for the `groupBy` cases, and its assignment is chosen to
 * DISCRIMINATE too: `alpha`'s MAX is 10 numerically but `"9"` byte-wise, while
 * `beta`'s only value sits between them — so ordering the groups by `_max`
 * swaps `alpha` and `beta` the moment the aggregate is taken over text.
 */
const ROWS = [
  { id: "r-nine", amount: "9", bucket: "alpha", note: "single digit" },
  {
    id: "r-ten",
    amount: "10",
    bucket: "alpha",
    note: "orders before 9 lexicographically",
  },
  {
    id: "r-nineandhalf",
    amount: "9.5",
    bucket: "beta",
    note: "between alpha's byte max (9) and its numeric max (10)",
  },
  {
    id: "r-tenth",
    amount: "0.10",
    bucket: "gamma",
    note: "canonicalizes to 0.1",
  },
  {
    id: "r-ninetenths",
    amount: "0.9",
    bucket: "gamma",
    note: "sorts before 0.10 as text",
  },
  {
    id: "r-thirty",
    // 30 fraction digits — a double keeps about 15
    amount: "1.000000000000000000000000000001",
    bucket: "gamma",
    note: "past double precision",
  },
  {
    id: "r-huge",
    // 2^53 + 1: the first integer a double cannot name
    amount: "9007199254740993",
    bucket: "gamma",
    note: "past 2^53",
  },
  { id: "r-neg", amount: "-2.5", bucket: "gamma", note: "negative" },
] as const;

/**
 * Ascending by VALUE. Byte order would give
 * -2.5, 0.1, 0.9, 1.000…001, 10, 9, 9.5, 9007199254740993 — the two orders
 * disagree from the fifth row on, so any window that reaches it discriminates.
 */
const ASCENDING_BY_VALUE = [
  "r-neg",
  "r-tenth",
  "r-ninetenths",
  "r-thirty",
  "r-nine",
  "r-nineandhalf",
  "r-ten",
  "r-huge",
] as const;

export function runDecimalExactnessBehavior({
  driverName,
  createDriver,
  exactDecimal,
}: DecimalExactnessOptions) {
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
        await active().ledger.create({ data: { ...row } });
      }
    };

    // =======================================================================
    // ROUND-TRIP — exact on every dialect, including SQLite
    // =======================================================================

    test("round-trips every value exactly, at any precision", async () => {
      await seed();

      const rows = await active().ledger.findMany();
      const byId = new Map(rows.map((row) => [row.id, row.amount]));

      expect(byId.get("r-thirty")).toBe("1.000000000000000000000000000001");
      expect(byId.get("r-huge")).toBe("9007199254740993");
      expect(byId.get("r-neg")).toBe("-2.5");
      expect(byId.get("r-nine")).toBe("9");
      // Canonicalized on the way in: "0.10" and "0.1" are the same number
      expect(byId.get("r-tenth")).toBe("0.1");
      for (const amount of byId.values()) {
        expect(typeof amount).toBe("string");
      }
    });

    test("a high-scale value survives an update, not just a create", async () => {
      await seed();
      const exact = "-0.000000000000000000000000000007";

      await active().ledger.update({
        where: { id: "r-nine" },
        data: { amount: exact },
      });

      const row = await active().ledger.findUnique({ where: { id: "r-nine" } });
      expect(row?.amount).toBe(exact);
    });

    test("a number operand is stored as the double the caller had", async () => {
      // The documented convenience, and its documented caveat, end to end.
      await active().ledger.create({
        data: {
          id: "r-double",
          amount: 0.1 + 0.2,
          bucket: "alpha",
          note: "double error in",
        },
      });

      const row = await active().ledger.findUnique({
        where: { id: "r-double" },
      });
      expect(row?.amount).toBe("0.30000000000000004");
    });

    // =======================================================================
    // EQUALITY — exact on every dialect, including SQLite
    // =======================================================================

    test("equals matches on value, not on spelling", async () => {
      await seed();

      // "0.10" was stored; every spelling of that number must find it
      for (const spelling of ["0.1", "0.10", "0.100", "+0.1"]) {
        const found = await active().ledger.findMany({
          where: { amount: spelling },
        });
        expect(found.map((row) => row.id)).toEqual(["r-tenth"]);
      }
    });

    test("equals distinguishes values that only differ past double precision", async () => {
      await seed();

      // A double would round both of these to exactly 1 and match the wrong row
      const exact = await active().ledger.findMany({
        where: { amount: "1.000000000000000000000000000001" },
      });
      expect(exact.map((row) => row.id)).toEqual(["r-thirty"]);

      const one = await active().ledger.findMany({ where: { amount: "1" } });
      expect(one).toEqual([]);
    });

    test("equals distinguishes integers past 2^53", async () => {
      await seed();

      const hit = await active().ledger.findMany({
        where: { amount: "9007199254740993" },
      });
      expect(hit.map((row) => row.id)).toEqual(["r-huge"]);

      // The neighbouring integer a double would collapse this one into
      const miss = await active().ledger.findMany({
        where: { amount: "9007199254740992" },
      });
      expect(miss).toEqual([]);
    });

    test("in / notIn compare numerically", async () => {
      await seed();

      const inList = await active().ledger.findMany({
        where: { amount: { in: ["0.100", "9007199254740993"] } },
        select: { id: true },
      });
      expect(inList.map((row) => row.id).sort()).toEqual(["r-huge", "r-tenth"]);

      const notIn = await active().ledger.findMany({
        where: { amount: { notIn: ["9", "9.5", "10", "0.1", "0.9", "-2.5"] } },
        select: { id: true },
      });
      expect(notIn.map((row) => row.id).sort()).toEqual(["r-huge", "r-thirty"]);
    });

    test("not excludes by value", async () => {
      await seed();

      const rows = await active().ledger.findMany({
        where: { amount: { not: "0.10" } },
        select: { id: true },
      });
      expect(rows.map((row) => row.id)).not.toContain("r-tenth");
      expect(rows).toHaveLength(ROWS.length - 1);
    });

    // =======================================================================
    // ORDERED AND DERIVED — exact on PG/MySQL, REFUSED on SQLite
    // =======================================================================

    if (exactDecimal) {
      test("gt/lt compare numerically, not lexicographically", async () => {
        await seed();

        // The discriminating pair: "9" > "10" as text, 9 < 10 as numbers
        const overNine = await active().ledger.findMany({
          where: { amount: { gt: "9" } },
          select: { id: true },
        });
        expect(overNine.map((row) => row.id).sort()).toEqual([
          "r-huge",
          "r-nineandhalf",
          "r-ten",
        ]);

        // "0.10" < "0.9" as text; 0.1 < 0.9 as numbers — same direction here,
        // so the discriminating direction is the other one
        const underHalf = await active().ledger.findMany({
          where: { amount: { lt: "0.5" } },
          select: { id: true },
        });
        expect(underHalf.map((row) => row.id).sort()).toEqual([
          "r-neg",
          "r-tenth",
        ]);
      });

      test("gt is exact past double precision", async () => {
        await seed();

        // 1.000000000000000000000000000001 > 1 is true exactly; through a
        // double both sides are 1 and the row is silently missed
        const rows = await active().ledger.findMany({
          where: { amount: { gt: "1", lt: "1.5" } },
          select: { id: true },
        });
        expect(rows.map((row) => row.id)).toEqual(["r-thirty"]);
      });

      test("gte/lte include the boundary exactly", async () => {
        await seed();

        const rows = await active().ledger.findMany({
          where: { amount: { gte: "9", lte: "10" } },
          select: { id: true },
        });
        expect(rows.map((row) => row.id).sort()).toEqual([
          "r-nine",
          "r-nineandhalf",
          "r-ten",
        ]);
      });

      test("orderBy sorts numerically", async () => {
        await seed();

        const rows = await active().ledger.findMany({
          orderBy: { amount: "asc" },
          select: { id: true },
        });
        // Byte order would put "10" before "9" and "0.10" before "0.9"
        expect(rows.map((row) => row.id)).toEqual([...ASCENDING_BY_VALUE]);
      });

      test("a WINDOW over that order is numeric too — take, skip and cursor", async () => {
        await seed();

        // The ordinary spelling of a sorted list. Byte order would answer
        // "…, 10, 9" here, so the fifth and sixth rows discriminate.
        const firstSix = await active().ledger.findMany({
          orderBy: { amount: "asc" },
          take: 6,
          select: { id: true },
        });
        expect(firstSix.map((row) => row.id)).toEqual(
          ASCENDING_BY_VALUE.slice(0, 6)
        );

        // skip + take selects a different SET, not merely a different order
        const middle = await active().ledger.findMany({
          orderBy: { amount: "asc" },
          skip: 4,
          take: 2,
          select: { id: true },
        });
        expect(middle.map((row) => row.id)).toEqual([
          "r-nine",
          "r-nineandhalf",
        ]);

        // Second largest: 10 numerically, "9.5" by bytes
        const secondLargest = await active().ledger.findFirst({
          orderBy: { amount: "desc" },
          skip: 1,
          select: { id: true },
        });
        expect(secondLargest?.id).toBe("r-ten");

        const page = await active().ledger.findMany({
          orderBy: { amount: "asc" },
          cursor: { id: "r-thirty" },
          take: 3,
          select: { id: true },
        });
        expect(page.map((row) => row.id)).toEqual([
          "r-thirty",
          "r-nine",
          "r-nineandhalf",
        ]);
      });

      test("groupBy orders groups and aggregates numerically", async () => {
        await seed();

        const byAmount = await active().ledger.groupBy({
          by: ["amount"],
          orderBy: { amount: "asc" },
          _count: true,
        });
        expect(byAmount.map((group) => group.amount)).toEqual([
          "-2.5",
          "0.1",
          "0.9",
          "1.000000000000000000000000000001",
          "9",
          "9.5",
          "10",
          "9007199254740993",
        ]);

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
      });

      test("groupBy having filters on the exact aggregate", async () => {
        await seed();

        // alpha's MIN is 9 numerically and "10" by bytes; only beta's 9.5
        // clears the bound, and a byte-order MIN would wrongly add alpha.
        const minOverBound = await active().ledger.groupBy({
          by: ["bucket"],
          having: { amount: { _min: { gt: 9.2 } } },
          _count: true,
        });
        expect(minOverBound.map((group) => group.bucket)).toEqual(["beta"]);

        const sumOverBound = await active().ledger.groupBy({
          by: ["bucket"],
          having: { amount: { _sum: { gt: 100 } } },
          _count: true,
        });
        expect(sumOverBound.map((group) => group.bucket)).toEqual(["gamma"]);

        const maxUnderBound = await active().ledger.groupBy({
          by: ["bucket"],
          having: { amount: { _max: { lt: 9.6 } } },
          _count: true,
        });
        expect(maxUnderBound.map((group) => group.bucket)).toEqual(["beta"]);
      });

      test("atomic arithmetic is exact and stays server-side", async () => {
        await active().ledger.create({
          data: {
            id: "r-math",
            amount: "0.1",
            bucket: "alpha",
            note: "arithmetic",
          },
        });

        await active().ledger.update({
          where: { id: "r-math" },
          data: { amount: { increment: "0.2" } },
        });
        const incremented = await active().ledger.findUnique({
          where: { id: "r-math" },
        });
        // The whole point: 0.1 + 0.2 is 0.3 exactly, not 0.30000000000000004
        expect(incremented?.amount).toBe("0.3");

        await active().ledger.update({
          where: { id: "r-math" },
          data: { amount: { multiply: "3" } },
        });
        const multiplied = await active().ledger.findUnique({
          where: { id: "r-math" },
        });
        expect(multiplied?.amount).toBe("0.9");

        await active().ledger.update({
          where: { id: "r-math" },
          data: { amount: { decrement: "0.9" } },
        });
        const zeroed = await active().ledger.findUnique({
          where: { id: "r-math" },
        });
        expect(zeroed?.amount).toBe("0");
      });

      test("increment is exact past double precision", async () => {
        await active().ledger.create({
          data: {
            id: "r-tiny",
            amount: "1",
            bucket: "alpha",
            note: "tiny increment",
          },
        });

        await active().ledger.update({
          where: { id: "r-tiny" },
          data: { amount: { increment: "0.000000000000000000000000000001" } },
        });

        const row = await active().ledger.findUnique({
          where: { id: "r-tiny" },
        });
        // Through a double this addition is a no-op
        expect(row?.amount).toBe("1.000000000000000000000000000001");
      });

      test("_sum, _min, _max and _avg come back as exact strings", async () => {
        await active().ledger.create({
          data: { id: "a", amount: "0.1", bucket: "alpha", note: "a" },
        });
        await active().ledger.create({
          data: { id: "b", amount: "0.2", bucket: "alpha", note: "b" },
        });
        // Past double precision, and chosen so the AVERAGE of the three is too:
        // (1.000000000000000000000000000001 + 0.1 + 0.2) / 3 keeps digits a
        // double throws away.
        await active().ledger.create({
          data: {
            id: "c",
            amount: "1.000000000000000000000000000001",
            bucket: "alpha",
            note: "c",
          },
        });

        const result = await active().ledger.aggregate({
          _sum: { amount: true },
          _min: { amount: true },
          _max: { amount: true },
          _avg: { amount: true },
        });

        expect(typeof result._sum.amount).toBe("string");
        // Float summation would give 1.3000000000000003
        expect(result._sum.amount).toBe("1.300000000000000000000000000001");
        expect(result._min.amount).toBe("0.1");
        expect(result._max.amount).toBe("1.000000000000000000000000000001");
        // `_avg` is the one aggregate that would otherwise widen to a JS
        // number: parsed as a double this is 0.43333333333333335, and every
        // digit past the seventeenth is gone.
        expect(typeof result._avg.amount).toBe("string");
        expect(result._avg.amount).toBe("0.433333333333333333333333333334");
      });
    } else {
      test("ordered filters are REFUSED, never answered through a double", async () => {
        await seed();

        for (const filter of [
          { gt: "9" },
          { gte: "9" },
          { lt: "9" },
          { lte: "9" },
        ]) {
          await expect(
            active().ledger.findMany({ where: { amount: filter } })
          ).rejects.toThrow(UnsupportedOperationError);
        }
      });

      test("the refusal names the field and points somewhere useful", async () => {
        await seed();

        await expect(
          active().ledger.findMany({ where: { amount: { gt: "9" } } })
        ).rejects.toThrow(REFUSAL_NAMES_FIELD);
        await expect(
          active().ledger.findMany({ where: { amount: { gt: "9" } } })
        ).rejects.toThrow(REFUSAL_SUGGESTS_NUMBER);
      });

      test("orderBy on a decimal is REFUSED", async () => {
        await seed();

        await expect(
          active().ledger.findMany({ orderBy: { amount: "asc" } })
        ).rejects.toThrow(UnsupportedOperationError);
      });

      test("a WINDOW over that order is REFUSED too, not silently answered", async () => {
        await seed();

        // The gate used to live only on the unwindowed spelling above, so the
        // paginated list — the spelling callers actually write — came back
        // sorted by bytes with no error at all.
        await expect(
          active().ledger.findMany({ orderBy: { amount: "desc" }, take: 1 })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.findMany({
            orderBy: { amount: "asc" },
            skip: 1,
            take: 2,
          })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.findMany({
            orderBy: { amount: "asc" },
            cursor: { id: "r-thirty" },
            take: 3,
          })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.findFirst({ orderBy: { amount: "desc" } })
        ).rejects.toThrow(UnsupportedOperationError);
      });

      test("groupBy ordering on a decimal is REFUSED", async () => {
        await seed();

        await expect(
          active().ledger.groupBy({
            by: ["amount"],
            orderBy: { amount: "asc" },
            _count: true,
          })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.groupBy({
            by: ["bucket"],
            orderBy: { _max: { amount: "desc" } },
            _count: true,
          })
        ).rejects.toThrow(UnsupportedOperationError);
      });

      test("groupBy having on a decimal aggregate is REFUSED", async () => {
        await seed();

        for (const having of [
          { amount: { _max: { gt: 5 } } },
          { amount: { _min: { lt: 5 } } },
          { amount: { _sum: { gt: 5 } } },
          { amount: { _avg: { gte: 5 } } },
        ]) {
          await expect(
            active().ledger.groupBy({ by: ["bucket"], having, _count: true })
          ).rejects.toThrow(UnsupportedOperationError);
        }
      });

      test("atomic arithmetic on a decimal is REFUSED", async () => {
        await seed();

        for (const op of [
          { increment: "1" },
          { decrement: "1" },
          { multiply: "2" },
          { divide: "2" },
        ]) {
          await expect(
            active().ledger.update({
              where: { id: "r-nine" },
              data: { amount: op },
            })
          ).rejects.toThrow(UnsupportedOperationError);
        }
      });

      test("decimal aggregates are REFUSED", async () => {
        await seed();

        await expect(
          active().ledger.aggregate({ _sum: { amount: true } })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.aggregate({ _avg: { amount: true } })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.aggregate({ _min: { amount: true } })
        ).rejects.toThrow(UnsupportedOperationError);
        await expect(
          active().ledger.aggregate({ _max: { amount: true } })
        ).rejects.toThrow(UnsupportedOperationError);
      });

      test("what stays allowed still works: equality, set, count", async () => {
        await seed();

        // `set` is an assignment, not arithmetic — it needs no exact decimal
        await active().ledger.update({
          where: { id: "r-nine" },
          data: { amount: { set: "12.750" } },
        });
        const row = await active().ledger.findUnique({
          where: { id: "r-nine" },
        });
        expect(row?.amount).toBe("12.75");

        const counted = await active().ledger.count({
          where: { amount: "12.75" },
        });
        expect(counted).toBe(1);
      });
    }
  });
}

export const decimalExactnessContract = defineContract({
  id: "drivers.decimal-exactness",
  owningLayer: "drivers",
  tier: "extended",
  requiredCapabilities: ["sql-execution"],
  register: runDecimalExactnessBehavior,
});
