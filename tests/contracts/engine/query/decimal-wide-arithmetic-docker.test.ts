/**
 * MySQL decimal arithmetic OUTSIDE the SQLite-legal intersection, live.
 *
 * The shared exactness contract runs at `precision: 16, scale: 2` because that
 * is what every provider admits (plan 3.1's SQLite bound is `precision + scale
 * <= 18`). MySQL admits `precision <= 65, scale <= 30`, and the descriptors
 * only IT admits are exactly the ones its 65-digit exact decimal domain makes
 * hard — so they have no coverage anywhere else, and they are where the
 * previous lowering was silently wrong:
 *
 *   `column * by * 10^s` at `{precision: 35, scale: 30}`, live on MySQL 8.4:
 *      1.5 * 1.5  ->  0.000000000000000000000000000000
 *
 * No warning, no error, no row left unchanged: MySQL types a product as
 * `DECIMAL(p1+p2, s1+s2)` capped at `(65, 30)`, and an over-wide one answers
 * ZERO. The same descriptor's exact product needs 60 fractional digits, twice
 * MySQL's expression ceiling, which is why the rule is stated on COEFFICIENTS
 * (integers have no fractional digits to cap) and why every intermediate below
 * is bounded by construction.
 *
 * The expectations are recomputed here in `bigint` — a half-even rounder
 * written in this file, not the implementation's — so a wrong answer that both
 * sides agree on still fails.
 *
 * Requires the Docker test database:
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const MYSQL = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfMysql = MYSQL ? describe : describe.skip;

/** `n / d` half to even, for `d > 0` — the grader, written independently. */
const halfEven = (n: bigint, d: bigint): bigint => {
  const q = n / d;
  const r = n % d;
  const magnitude = r < 0n ? -r : r;
  if (magnitude * 2n > d || (magnitude * 2n === d && q % 2n !== 0n)) {
    return q + (r < 0n ? -1n : 1n);
  }
  return q;
};

/** The unscaled coefficient of canonical decimal text. */
const coefficientOf = (text: string, scale: number): bigint => {
  const negative = text.startsWith("-");
  const [whole = "0", fraction = ""] = (negative ? text.slice(1) : text).split(
    "."
  );
  const digits = `${whole}${fraction.padEnd(scale, "0")}`;
  const value = BigInt(digits.slice(0, whole.length + scale));
  return negative ? -value : value;
};

/** Canonical text for an unscaled coefficient. */
const logicalOf = (coefficient: bigint, scale: number): string => {
  const negative = coefficient < 0n;
  const digits = (negative ? -coefficient : coefficient)
    .toString()
    .padStart(scale + 1, "0");
  const cut = digits.length - scale;
  const literal =
    scale === 0 ? digits : `${digits.slice(0, cut)}.${digits.slice(cut)}`;
  const canonical = canonicalizeDecimal(literal);
  if (canonical === undefined) throw new Error(`not a decimal: ${literal}`);
  return negative && canonical !== "0" ? `-${canonical}` : canonical;
};

/**
 * The three descriptors, chosen for what each one breaks.
 *
 * `(40,2)` and `(30,20)` are past SQLite's bound but inside MySQL's; `(35,30)`
 * is MySQL's own `precision + scale = 65` corner, where the exact product needs
 * 60 fractional digits. One digit beyond that edge is refused when the schema
 * binds, before an expression can exceed MySQL's exact domain.
 */
const DOMAINS = [
  { name: "40,2", descriptor: { precision: 40, scale: 2 } as const },
  { name: "30,20", descriptor: { precision: 30, scale: 20 } as const },
  { name: "35,30", descriptor: { precision: 35, scale: 30 } as const },
];

const modelFor = (descriptor: { precision: number; scale: number }) => ({
  reading: s
    .model({
      id: s.string().id(),
      amount: s.decimal(descriptor),
    })
    .map(`decimal_wide_${descriptor.precision}_${descriptor.scale}`),
});

describeIfMysql.each(DOMAINS)(
  "MySQL decimal arithmetic at ($name)",
  ({ descriptor }) => {
    const { scale } = descriptor;
    let client: any;

    const connect = async () => {
      if (client) return client;
      client = createClient({
        schema: modelFor(descriptor),
        driver: new MySQL2Driver({
          databaseUrl: MYSQL ?? "",
          migrationNamespaceAttestation: "non-redirecting",
        }),
      });
      await client.$executeRawUnsafe(
        `DROP TABLE IF EXISTS decimal_wide_${descriptor.precision}_${descriptor.scale}`
      );
      await push(client, { force: true });
      return client;
    };

    afterAll(async () => {
      await client?.$disconnect();
    });

    const seedAndRun = async (
      start: string,
      operation: Record<string, string>
    ): Promise<string> => {
      const db = await connect();
      await db.reading.deleteMany({});
      await db.reading.create({ data: { id: "r1", amount: start } });
      await db.reading.update({
        where: { id: "r1" },
        data: { amount: operation },
      });
      const row = await db.reading.findUnique({ where: { id: "r1" } });
      return canonicalizeDecimal(row.amount) as string;
    };

    // `1.5 x 1.5` is the case the previous lowering answered `0` at (65,30):
    // small values, a product needing four significant digits, and an
    // expression MySQL could not type.
    test("multiply is exact on small values", async () => {
      const x = coefficientOf("1.5", scale);
      const expected = logicalOf(halfEven(x * x, 10n ** BigInt(scale)), scale);

      expect(await seedAndRun("1.5", { multiply: "1.5" })).toBe(expected);
    }, 120_000);

    test("multiply rounds half to EVEN at the field's scale", async () => {
      // Five ULP halved is an exact tie between two representable values, and
      // the even neighbour is two ULP — the one answer half-up, half-down and
      // half-away-from-zero all get wrong.
      const start = logicalOf(5n, scale);
      const expected = logicalOf(
        halfEven(
          coefficientOf(start, scale) * coefficientOf("0.5", scale),
          10n ** BigInt(scale)
        ),
        scale
      );

      expect(await seedAndRun(start, { multiply: "0.5" })).toBe(expected);
      expect(expected).toBe(logicalOf(2n, scale));
    }, 120_000);

    // The discriminating case for the SCALE cap, and it only exists where the
    // cap can bite: MySQL types the exact product of two `DECIMAL(p,s)` values
    // at scale `2s` and then caps that at 30, so a tie decided by a digit
    // beyond the 30th is decided by a digit MySQL never computed. The fixture
    // is built to sit exactly there: the discarded tail is `0.5…01` of one ULP
    // — just PAST half, so the exact answer rounds away from zero — while the
    // capped tail is exactly `0.5`, a tie the even neighbour wins. The two
    // answers are one ULP apart, and the previous logical-space lowering gave
    // the second one.
    test("a tie decided BEYOND MySQL's expression scale is still decided", async () => {
      const factor = 10n ** BigInt(scale);
      const start = logicalOf(2n * factor + factor / 2n + 1n, scale);
      const ulp = logicalOf(1n, scale);

      // The grader: `x * 1 / 10^s` is `2` remainder `5…01`, and twice that
      // remainder is past `10^s`, so the answer is three ULP — never two.
      // At `(40,2)` the cap cannot bite (`2s <= 30`) and this is a control;
      // at the other two it is the discriminator.
      const expected = logicalOf(
        halfEven(coefficientOf(start, scale) * 1n, factor),
        scale
      );
      expect(expected).toBe(logicalOf(3n, scale));

      expect(await seedAndRun(start, { multiply: ulp })).toBe(expected);
    }, 120_000);

    test("divide is exact and rounds half to even", async () => {
      const start = "1";
      const x = coefficientOf(start, scale);
      const y = coefficientOf("8", scale);
      const expected = logicalOf(halfEven(x * 10n ** BigInt(scale), y), scale);

      expect(await seedAndRun(start, { divide: "8" })).toBe(expected);
    }, 120_000);

    test("a negative divisor keeps the away-from-zero direction", async () => {
      const start = "1";
      const x = coefficientOf(start, scale);
      const y = coefficientOf("8", scale);
      const expected = logicalOf(
        halfEven(-(x * 10n ** BigInt(scale)), y),
        scale
      );

      expect(await seedAndRun(start, { divide: "-8" })).toBe(expected);
    }, 120_000);

    test("_avg is the exact average, quantized to the scale", async () => {
      const db = await connect();
      await db.reading.deleteMany({});
      const rows = ["1", "2", "3", "4"];
      for (const [index, value] of rows.entries()) {
        await db.reading.create({ data: { id: `a${index}`, amount: value } });
      }
      const total = rows.reduce(
        (accumulator, value) => accumulator + coefficientOf(value, scale),
        0n
      );
      const expected = logicalOf(halfEven(total, BigInt(rows.length)), scale);

      const answer = await db.reading.aggregate({ _avg: { amount: true } });

      expect(canonicalizeDecimal(answer._avg.amount)).toBe(expected);
    }, 120_000);

    test("an out-of-domain product fails LOUDLY, row unchanged", async () => {
      const db = await connect();
      const max = logicalOf(10n ** BigInt(descriptor.precision) - 1n, scale);
      await db.reading.deleteMany({});
      await db.reading.create({ data: { id: "r1", amount: max } });

      await expect(
        db.reading.update({
          where: { id: "r1" },
          data: { amount: { multiply: max } },
        })
      ).rejects.toThrow();

      const row = await db.reading.findUnique({ where: { id: "r1" } });
      expect(canonicalizeDecimal(row.amount)).toBe(max);
    }, 120_000);
  }
);

describeIfMysql(
  "MySQL decimal aggregates at the 65-digit expression edge",
  () => {
    const descriptor = { precision: 65, scale: 0 } as const;
    let client: any;

    beforeAll(async () => {
      client = createClient({
        schema: modelFor(descriptor),
        driver: new MySQL2Driver({
          databaseUrl: MYSQL ?? "",
          migrationNamespaceAttestation: "non-redirecting",
        }),
      });
      await client.$executeRawUnsafe("DROP TABLE IF EXISTS decimal_wide_65_0");
      await push(client, { force: true });
    }, 120_000);

    afterAll(async () => {
      await client?.$disconnect();
    });

    test("SUM widens to 66 digits and AVG decides the tie without losing one", async () => {
      const maximum = 10n ** 65n - 1n;
      const lower = maximum - 1n;
      await client.reading.createMany({
        data: [
          { id: "upper", amount: maximum.toString() },
          { id: "lower", amount: lower.toString() },
        ],
      });

      const answer = await client.reading.aggregate({
        _sum: { amount: true },
        _avg: { amount: true },
      });

      expect(canonicalizeDecimal(answer._sum.amount)).toBe(
        (maximum + lower).toString()
      );
      // The exact average is maximum - 0.5. The lower neighbour is even.
      expect(canonicalizeDecimal(answer._avg.amount)).toBe(lower.toString());
    }, 120_000);
  }
);

/**
 * The other `precision + scale = 65` corner: almost the whole exact domain is
 * integer width. MySQL's `/` adds `div_precision_increment` fractional digits,
 * so converting a rounded coefficient back to its logical value must not spend
 * four of the integer digits the field still needs.
 */
describeIfMysql.each([
  { name: "64,1", descriptor: { precision: 64, scale: 1 } as const },
  { name: "63,2", descriptor: { precision: 63, scale: 2 } as const },
])("MySQL logical conversion at ($name)", ({ descriptor }) => {
  let client: any;

  beforeAll(async () => {
    client = createClient({
      schema: modelFor(descriptor),
      driver: new MySQL2Driver({
        databaseUrl: MYSQL ?? "",
        options: { connectionLimit: 1 },
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });
    await client.$executeRawUnsafe(
      `DROP TABLE IF EXISTS decimal_wide_${descriptor.precision}_${descriptor.scale}`
    );
    await push(client, { force: true });
  }, 120_000);

  afterAll(async () => {
    if (!client) return;
    await client.$executeRawUnsafe(
      "SET SESSION sql_mode = 'STRICT_TRANS_TABLES'"
    );
    await client.$disconnect();
  });

  test("the maximum coefficient survives strict and non-strict conversion", async () => {
    const maximum = logicalOf(
      10n ** BigInt(descriptor.precision) - 1n,
      descriptor.scale
    );
    await client.reading.create({ data: { id: "edge", amount: maximum } });

    for (const mode of ["STRICT_TRANS_TABLES", ""] as const) {
      await client.$executeRawUnsafe(`SET SESSION sql_mode = '${mode}'`);
      await client.reading.update({
        where: { id: "edge" },
        data: { amount: { multiply: "1" } },
      });
      const row = await client.reading.findUnique({ where: { id: "edge" } });
      expect(canonicalizeDecimal(row.amount)).toBe(maximum);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// NON-STRICT SESSIONS — the assignment itself owns loud exactness
// ---------------------------------------------------------------------------

const guardedSchema = {
  reading: s
    .model({
      id: s.string().id(),
      amount: s.decimal({ precision: 6, scale: 2 }),
      optional: s.decimal({ precision: 6, scale: 2 }).nullable(),
    })
    .map("decimal_nonstrict_guard"),
};

describeIfMysql(
  "MySQL decimal assignments are exact without a session prerequisite",
  () => {
    let client: any;

    const setMode = async (db: any, mode: string) => {
      await db.$executeRawUnsafe(`SET SESSION sql_mode = '${mode}'`);
    };

    beforeAll(async () => {
      client = createClient({
        schema: guardedSchema,
        driver: new MySQL2Driver({
          databaseUrl: MYSQL ?? "",
          options: { connectionLimit: 1 },
          migrationNamespaceAttestation: "non-redirecting",
        }),
      });
      await client.$executeRawUnsafe(
        "DROP TABLE IF EXISTS decimal_nonstrict_guard"
      );
      await push(client, { force: true });
    }, 120_000);

    afterAll(async () => {
      if (client) {
        await setMode(client, "STRICT_TRANS_TABLES");
        await client.$disconnect();
      }
    });

    const rows = async (db: any) =>
      db.reading.findMany({ orderBy: { id: "asc" } });

    const inNonStrictTransaction = async (
      run: (db: any) => Promise<void>
    ): Promise<void> => {
      await client.$transaction(async (tx: any) => {
        await setMode(tx, "");
        try {
          await run(tx);
        } finally {
          await setMode(tx, "STRICT_TRANS_TABLES");
        }
      });
    };

    test.each([
      ["increment", "1.00", "2.00", "3"],
      ["decrement", "1.00", "0.50", "0.5"],
      ["multiply", "1.25", "2.00", "2.5"],
      ["divide", "1.00", "8.00", "0.12"],
    ] as const)("non-strict %s keeps an in-range result exact", async (operation, start, operand, expected) => {
      await client.reading.deleteMany({});
      await client.reading.create({
        data: { id: "safe", amount: start, optional: null },
      });
      await inNonStrictTransaction(async (tx) => {
        await tx.reading.update({
          where: { id: "safe" },
          data: { amount: { [operation]: operand } },
        });
        const row = await tx.reading.findUnique({ where: { id: "safe" } });
        expect(row.amount.eq(expected)).toBe(true);
      });
    });

    test.each([
      ["increment", "9999.99", "0.01"],
      ["decrement", "-9999.99", "0.01"],
      ["multiply", "9999.99", "2.00"],
      ["divide", "9999.99", "0.01"],
    ] as const)("non-strict %s refuses overflow and leaves the row unchanged", async (operation, start, operand) => {
      await client.reading.deleteMany({});
      await client.reading.create({
        data: { id: "over", amount: start, optional: null },
      });
      await inNonStrictTransaction(async (tx) => {
        await expect(
          tx.reading.update({
            where: { id: "over" },
            data: { amount: { [operation]: operand } },
          })
        ).rejects.toThrow();
        const row = await tx.reading.findUnique({ where: { id: "over" } });
        expect(row.amount.eq(start)).toBe(true);
      });
    });

    test("the unreachable error arm stays lazy, and NULL stays NULL", async () => {
      await client.reading.deleteMany({});
      await client.reading.create({
        data: { id: "null", amount: "1.00", optional: null },
      });
      await inNonStrictTransaction(async (tx) => {
        await expect(
          tx.reading.update({
            where: { id: "null" },
            data: { optional: { multiply: "9999.99" } },
          })
        ).resolves.toBeDefined();
        const row = await tx.reading.findUnique({ where: { id: "null" } });
        expect(row.optional).toBeNull();
      });
    });

    test("one overflowing updateMany row aborts the whole statement", async () => {
      await client.reading.deleteMany({});
      await client.reading.createMany({
        data: [
          { id: "a", amount: "1.00", optional: null },
          { id: "b", amount: "9999.99", optional: null },
        ],
      });
      await setMode(client, "");
      try {
        await expect(
          client.reading.updateMany({ data: { amount: { increment: "0.01" } } })
        ).rejects.toThrow();
        expect(
          (await rows(client)).map((row: any) => row.amount.toString())
        ).toEqual(["1", "9999.99"]);
      } finally {
        await setMode(client, "STRICT_TRANS_TABLES");
      }
    });

    test("the same refusal survives array-transaction admission", async () => {
      await client.reading.deleteMany({});
      await client.reading.create({
        data: { id: "array", amount: "9999.99", optional: null },
      });
      await setMode(client, "");
      try {
        await expect(
          client.$transaction([
            client.reading.update({
              where: { id: "array" },
              data: { amount: { multiply: "2.00" } },
            }),
            client.reading.findUnique({ where: { id: "array" } }),
          ])
        ).rejects.toThrow();
        const row = await client.reading.findUnique({ where: { id: "array" } });
        expect(row.amount.eq("9999.99")).toBe(true);
      } finally {
        await setMode(client, "STRICT_TRANS_TABLES");
      }
    });
  }
);
