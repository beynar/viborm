/**
 * Provider-backed decimal answers over the whole ordering and aggregate surface.
 *
 * This file used to enumerate a REFUSAL. A dialect with no exact decimal type
 * refused every ordered or derived decimal operation, and the enumeration
 * existed because the refusal was a claim about a *surface* rather than about
 * one call site — it had been absent from `findMany({ orderBy, take })`,
 * `findFirst`, cursor pagination, relation `orderBy`, nested-read `orderBy`,
 * `groupBy`'s `orderBy` and `groupBy`'s aggregate `having`, which is to say
 * from most of the spellings callers actually write.
 *
 * SQLite now stores the unscaled integer COEFFICIENT, so those questions have
 * exact answers there too and the refusal is gone. The enumeration is what
 * survives, inverted: every spelling below runs on PGlite (native `numeric`)
 * and on SQLite3 (integer coefficients) and must return the SAME answer.
 *
 * PGlite is the oracle, and the FIXTURES are what stop the two sides from being
 * identically wrong:
 *
 *  - `"9"` and `"10"` disagree between numeric and LEXICAL order, which is what
 *    the old canonical-TEXT storage answered.
 *  - `99999999999999.98` and `99999999999999.99` are one unit apart in the last
 *    place of a 16-digit domain and land on the SAME IEEE-754 double, so any
 *    path that goes through a float collapses them.
 *  - the sum of the fixture rows needs SEVENTEEN coefficient digits, one more
 *    than the field's own precision, so `_sum` is exercised outside the domain
 *    every other operation stays inside.
 *
 * `precision: 16, scale: 2` is chosen so `precision + scale <= 18` holds: it is
 * SQLite's declared field limit, and it is what makes the one-statement
 * arithmetic safe.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { s } from "@schema";
import { syncLiveSchema as push } from "@tests/fixtures/sync-schema";
import { canonicalizeDecimal } from "@validation/primitives/decimal-codec";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const MONEY = { precision: 16, scale: 2 } as const;

const account = s
  .model({
    id: s.string().id(),
    fee: s.decimal(MONEY),
    entries: s.toMany(() => entry),
  })
  .map("decimal_surface_accounts");

const entry = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal(MONEY),
    // `.nullable()` REBUILDS the scalar state, and every lowering below reads
    // the descriptor off that state. A nullable decimal is no less ordered than
    // a required one, so it is enumerated separately rather than assumed.
    optionalAmount: s.decimal(MONEY).nullable(),
    accountId: s.string(),
    account: s
      .toOne(() => account)
      .fields("accountId")
      .references("id"),
  })
  .map("decimal_surface_entries");

/** A decimal PRIMARY KEY: it becomes the pagination tie-breaker unasked. */
const token = s
  .model({
    serial: s.decimal(MONEY).id(),
    label: s.string(),
  })
  .map("decimal_surface_tokens");

/** A decimal UNIQUE key: legal as a `cursor`, appended as a tie-breaker. */
const coupon = s
  .model({
    id: s.string().id(),
    faceValue: s.decimal(MONEY).unique(),
  })
  .map("decimal_surface_coupons");

/**
 * A decimal inside a COMPOUND primary key.
 *
 * The tie-breaker vector is resolved by a different branch than the single
 * scalar `@id` above (`getCanonicalIdentityFields` falls through to the
 * compound constraint), and that branch reaches the decimal just as unasked.
 */
const slot = s
  .model({
    serial: s.decimal(MONEY),
    region: s.string(),
    payload: s.string(),
  })
  .id(["serial", "region"])
  .map("decimal_surface_slots");

const schema = { account, entry, token, coupon, slot };

type SurfaceClient = ReturnType<typeof createPGliteClient>;

const borrowedPGliteClients = new Set<PGlite>();

const createPGliteClient = () => {
  const client = new PGlite();
  borrowedPGliteClients.add(client);
  return createClient({ schema, driver: new PGliteDriver({ client }) });
};

afterAll(async () => {
  await Promise.all(
    [...borrowedPGliteClients].map((client) => client.close())
  );
});

const createSQLiteClient = () =>
  createClient({ schema, driver: new SQLite3Driver({ dataDir: ":memory:" }) });

/** The two values a double cannot tell apart, one ULP of the domain apart. */
const NEAR_MAX_LOW = "99999999999999.98";
const NEAR_MAX_HIGH = "99999999999999.99";

const seed = async (client: SurfaceClient): Promise<void> => {
  await client.account.create({ data: { id: "a-hi", fee: "9" } });
  await client.account.create({ data: { id: "a-lo", fee: "10" } });

  const entries = [
    {
      id: "e1",
      bucket: "b",
      amount: "9",
      optionalAmount: "9",
      accountId: "a-hi",
    },
    {
      id: "e2",
      bucket: "b",
      amount: "10",
      optionalAmount: "10",
      accountId: "a-lo",
    },
    {
      id: "e3",
      bucket: "c",
      amount: "1",
      optionalAmount: null,
      accountId: "a-hi",
    },
    {
      id: "e4",
      bucket: "c",
      amount: NEAR_MAX_LOW,
      optionalAmount: NEAR_MAX_LOW,
      accountId: "a-lo",
    },
    {
      id: "e5",
      bucket: "c",
      amount: NEAR_MAX_HIGH,
      optionalAmount: NEAR_MAX_HIGH,
      accountId: "a-hi",
    },
  ];
  for (const row of entries) {
    await client.entry.create({ data: row });
  }

  await client.token.create({ data: { serial: "9", label: "nine" } });
  await client.token.create({ data: { serial: "10", label: "ten" } });

  await client.coupon.create({ data: { id: "c1", faceValue: "9" } });
  await client.coupon.create({ data: { id: "c2", faceValue: "10" } });

  await client.slot.create({
    data: { serial: "9", region: "eu", payload: "nine" },
  });
  await client.slot.create({
    data: { serial: "10", region: "eu", payload: "ten" },
  });
};

/**
 * Render a result to a comparable shape.
 *
 * Decimal values are reduced to their CANONICAL text through the one codec, so
 * two providers agree when they name the same number and disagree when they do
 * not — a `Decimal` instance, a physical coefficient string and a JavaScript
 * number are three different things that this deliberately does not smooth
 * over: `canonicalizeDecimal` of a coefficient is the coefficient, so a missing
 * decode shows up as a difference rather than as an equality.
 */
const normalize = (value: unknown): unknown => {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map(normalize);
  if (typeof value === "object") {
    const decimal = canonicalizeDecimal(value);
    if (decimal !== undefined) return decimal;
    const entries_ = Object.entries(value).map(([key, member]) => [
      key,
      normalize(member),
    ]);
    entries_.sort((left, right) =>
      String(left[0]).localeCompare(String(right[0]))
    );
    return Object.fromEntries(entries_);
  }
  if (typeof value === "number") return canonicalizeDecimal(value);
  return value;
};

type Spelling = {
  name: string;
  /** `PromiseLike`, not `Promise`: client calls return a thenable builder. */
  run: (client: SurfaceClient) => PromiseLike<unknown>;
  /**
   * The answer both providers must give, when it is worth stating outright.
   *
   * Provider AGREEMENT alone cannot catch two identically-wrong answers, and
   * lexical order is exactly the failure both would have shared before the
   * coefficient storage landed. Where the ordering is the point, the expected
   * answer is written down.
   */
  expected?: unknown;
};

const ids = (rows: unknown): unknown =>
  Array.isArray(rows)
    ? rows.map((row) =>
        row && typeof row === "object" && "id" in row ? row.id : row
      )
    : rows;

/**
 * Every public spelling that puts a decimal into an ORDER BY expression or into
 * an ordered/derived aggregate — the exact set this file used to assert was
 * refused.
 */
const SPELLINGS: Spelling[] = [
  // --- ordering, unwindowed ---
  {
    name: "findMany orderBy",
    run: async (c) =>
      ids(await c.entry.findMany({ orderBy: { amount: "asc" } })),
    expected: ["e3", "e1", "e2", "e4", "e5"],
  },
  // --- ordering, windowed: the ordinary spelling of a sorted list ---
  {
    name: "findMany orderBy + take",
    run: async (c) =>
      ids(await c.entry.findMany({ orderBy: { amount: "desc" }, take: 2 })),
    expected: ["e5", "e4"],
  },
  {
    name: "findMany orderBy + negative take",
    run: async (c) =>
      ids(await c.entry.findMany({ orderBy: { amount: "asc" }, take: -2 })),
  },
  {
    name: "findMany orderBy + skip + take",
    run: async (c) =>
      ids(
        await c.entry.findMany({ orderBy: { amount: "asc" }, skip: 1, take: 2 })
      ),
    expected: ["e1", "e2"],
  },
  {
    name: "findMany orderBy + cursor",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          orderBy: { amount: "asc" },
          cursor: { id: "e1" },
          take: 2,
        })
      ),
    expected: ["e1", "e2"],
  },
  {
    name: "findMany orderBy nulls placement + take",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          orderBy: { optionalAmount: { sort: "asc", nulls: "last" } },
          take: 3,
        })
      ),
    expected: ["e1", "e2", "e4"],
  },
  {
    name: "findFirst orderBy",
    run: async (c) =>
      ids([await c.entry.findFirst({ orderBy: { amount: "desc" } })]),
    expected: ["e5"],
  },
  // --- the decimal is never named: it arrives as a tie-breaker ---
  {
    name: "take on a model whose primary key is a decimal",
    run: async (c) =>
      (await c.token.findMany({ take: 1 })).map((row) => row.label),
    expected: ["nine"],
  },
  {
    name: "cursor on a unique decimal key",
    run: async (c) =>
      ids(await c.coupon.findMany({ cursor: { faceValue: "9" }, take: 1 })),
    expected: ["c1"],
  },
  {
    name: "take on a model whose compound primary key contains a decimal",
    run: async (c) =>
      (await c.slot.findMany({ take: 1 })).map((row) => row.payload),
    expected: ["nine"],
  },
  // --- ordering one hop away ---
  {
    // The `id` key is a TIE-BREAK, not decoration: two entries share an account
    // and therefore share a fee, and a relation order carries no implicit
    // tie-break — without it the two providers are each free to return the tied
    // rows in any order and the comparison would be measuring the plan.
    name: "findMany orderBy through a to-one relation",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          orderBy: [{ account: { fee: "asc" } }, { id: "asc" }],
        })
      ),
    expected: ["e1", "e3", "e5", "e2", "e4"],
  },
  {
    name: "findMany orderBy through a to-one relation + take",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          orderBy: [{ account: { fee: "asc" } }, { id: "asc" }],
          take: 2,
        })
      ),
    expected: ["e1", "e3"],
  },
  // --- ordering inside a nested read window ---
  {
    name: "include with a nested orderBy",
    run: async (c) =>
      (
        await c.account.findMany({
          orderBy: { id: "asc" },
          include: { entries: { orderBy: { amount: "asc" } } },
        })
      ).map((row) => ids(row.entries)),
    expected: [
      ["e3", "e1", "e5"],
      ["e2", "e4"],
    ],
  },
  {
    name: "include with a nested orderBy + take",
    run: async (c) =>
      (
        await c.account.findMany({
          orderBy: { id: "asc" },
          include: { entries: { orderBy: { amount: "asc" }, take: 1 } },
        })
      ).map((row) => ids(row.entries)),
    expected: [["e3"], ["e2"]],
  },
  {
    name: "include with a nested orderBy THROUGH a relation",
    run: async (c) =>
      (
        await c.account.findMany({
          orderBy: { id: "asc" },
          include: { entries: { orderBy: { account: { fee: "asc" } } } },
        })
      ).map((row) => (row.entries ?? []).length),
  },
  // --- the same operations on a NULLABLE decimal ---
  {
    name: "findMany orderBy a nullable decimal + take",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          orderBy: { optionalAmount: "asc" },
          take: 2,
        })
      ),
    expected: ["e1", "e2"],
  },
  {
    name: "where gt on a nullable decimal",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          where: { optionalAmount: { gt: "5" } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["e1", "e2", "e4", "e5"],
  },
  {
    name: "aggregate _max of a nullable decimal",
    run: (c) => c.entry.aggregate({ _max: { optionalAmount: true } }),
    expected: { _max: { optionalAmount: NEAR_MAX_HIGH } },
  },
  {
    name: "groupBy having _min of a nullable decimal",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { optionalAmount: { _min: { lt: "5" } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: [],
  },
  // --- aggregate windows (count/aggregate share the pagination window) ---
  {
    name: "count with orderBy + take",
    run: (c) => c.entry.count({ orderBy: { amount: "asc" }, take: 2 }),
    expected: 2,
  },
  {
    name: "aggregate with orderBy + take",
    run: (c) =>
      c.entry.aggregate({ _count: true, orderBy: { amount: "asc" }, take: 2 }),
    expected: { _count: 2 },
  },
  // --- selected aggregates ---
  {
    name: "aggregate _max",
    run: (c) => c.entry.aggregate({ _max: { amount: true } }),
    expected: { _max: { amount: NEAR_MAX_HIGH } },
  },
  {
    name: "aggregate _min",
    run: (c) => c.entry.aggregate({ _min: { amount: true } }),
    expected: { _min: { amount: "1" } },
  },
  {
    // The sum needs SEVENTEEN coefficient digits; the field's precision is 16.
    // It is
    // an exact answer the column could not itself hold, and it must not be
    // rejected for that (plan 5.4).
    name: "aggregate _sum past the field precision",
    run: (c) => c.entry.aggregate({ _sum: { amount: true } }),
    expected: { _sum: { amount: "200000000000019.97" } },
  },
  {
    // 200000000000019.97 / 5 = 40000000000003.994, which is not representable
    // at scale 2 and rounds DOWN (the digit past the scale is below a half).
    name: "aggregate _avg quantized to the field scale",
    run: (c) => c.entry.aggregate({ _avg: { amount: true } }),
    expected: { _avg: { amount: "40000000000003.99" } },
  },
  {
    name: "groupBy selecting _sum",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          orderBy: { bucket: "asc" },
          _sum: { amount: true },
        })
      ).map((row) => [row.bucket, row._sum?.amount]),
    expected: [
      ["b", "19"],
      ["c", "200000000000000.97"],
    ],
  },
  // --- groupBy ordering ---
  {
    name: "groupBy orderBy a grouped decimal",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["amount"],
          orderBy: { amount: "asc" },
          _count: true,
        })
      ).map((row) => row.amount),
    expected: ["1", "9", "10", NEAR_MAX_LOW, NEAR_MAX_HIGH],
  },
  {
    name: "groupBy orderBy _max",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          orderBy: { _max: { amount: "desc" } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c", "b"],
  },
  {
    name: "groupBy orderBy _sum",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          orderBy: { _sum: { amount: "desc" } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c", "b"],
  },
  {
    name: "groupBy orderBy _avg",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          orderBy: { _avg: { amount: "desc" } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c", "b"],
  },
  {
    name: "groupBy orderBy _min",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          orderBy: { _min: { amount: "asc" } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c", "b"],
  },
  // --- groupBy having, every derived aggregate ---
  {
    name: "groupBy having _max",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { amount: { _max: { gt: "50" } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c"],
  },
  {
    name: "groupBy having _min",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { amount: { _min: { lt: "5" } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c"],
  },
  {
    name: "groupBy having _sum in the widened domain",
    // Eighteen coefficient digits against a `precision: 16` field: wider than
    // any single row, and inside every provider's own aggregate domain — which
    // is where the widening stops (`decimal-field.ts` `widenedSumDomain`). A
    // SQLite operand is admitted by exact signed-int64 value: part of the
    // 19-digit domain fits, and values beyond either endpoint are refused
    // rather than compared against a saturated integer.
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { amount: { _sum: { gt: "9999999999999999.99" } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: [],
  },
  {
    name: "groupBy having _avg",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { amount: { _avg: { gte: "10" } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c"],
  },
  {
    name: "groupBy having _sum nested under NOT",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { NOT: [{ amount: { _sum: { gt: "50" } } }] },
          orderBy: { bucket: "asc" },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["b"],
  },
  // --- ordered comparisons and arithmetic ---
  {
    name: "where gt",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          where: { amount: { gt: "9" } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["e2", "e4", "e5"],
  },
  {
    // The two fixtures one ULP apart: a float path answers this with both rows
    // or neither, because they are the same double.
    name: "where gt discriminating two values one ULP apart",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          where: { amount: { gt: NEAR_MAX_LOW } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["e5"],
  },
  {
    name: "where gt through a relation",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          where: { account: { fee: { gt: "9" } } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["e2", "e4"],
  },
  {
    name: "having on a grouped decimal with gt",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["amount"],
          having: { amount: { gt: "9" } },
          orderBy: { amount: "asc" },
          _count: true,
        })
      ).map((row) => row.amount),
    expected: ["10", NEAR_MAX_LOW, NEAR_MAX_HIGH],
  },
  {
    name: "update with increment",
    run: async (c) =>
      (
        await c.entry.update({
          where: { id: "e3" },
          data: { amount: { increment: "0.05" } },
        })
      ).amount,
    expected: "1.05",
  },
  {
    name: "update with decrement",
    run: async (c) =>
      (
        await c.entry.update({
          where: { id: "e3" },
          data: { amount: { decrement: "0.05" } },
        })
      ).amount,
    expected: "1",
  },
];

/**
 * What must keep working, and keep MEANING the same, beside the ordered
 * surface. Without these a change that answered every ordering by silently
 * rewriting the storage would still look green.
 */
const CONTROLS: Spelling[] = [
  {
    name: "findMany where equals",
    run: async (c) => ids(await c.entry.findMany({ where: { amount: "9" } })),
    expected: ["e1"],
  },
  {
    name: "findMany where in",
    run: async (c) =>
      ids(
        await c.entry.findMany({
          where: { amount: { in: ["9", "10"] } },
          orderBy: { id: "asc" },
        })
      ),
    expected: ["e1", "e2"],
  },
  {
    name: "findMany distinct on a decimal",
    run: async (c) =>
      (
        await c.entry.findMany({
          distinct: ["amount"],
          orderBy: { amount: "asc" },
        })
      ).map((row) => row.amount),
    expected: ["1", "9", "10", NEAR_MAX_LOW, NEAR_MAX_HIGH],
  },
  {
    name: "findUnique by a decimal primary key",
    run: async (c) =>
      (await c.token.findUnique({ where: { serial: "9" } }))?.label,
    expected: "nine",
  },
  {
    name: "findMany where null on a nullable decimal",
    run: async (c) =>
      ids(await c.entry.findMany({ where: { optionalAmount: null } })),
    expected: ["e3"],
  },
  {
    // `_count` counts ROWS, on any storage. It must not be widened, quantized
    // or otherwise pulled into the decimal rule — a gate that "fixed" it would
    // be a false answer in the other direction.
    name: "aggregate _count over a decimal column",
    run: (c) => c.entry.aggregate({ _count: { amount: true } }),
    expected: { _count: { amount: 5 } },
  },
  {
    name: "groupBy having _count of a decimal column",
    run: async (c) =>
      (
        await c.entry.groupBy({
          by: ["bucket"],
          having: { amount: { _count: { gt: 2 } } },
          _count: true,
        })
      ).map((row) => row.bucket),
    expected: ["c"],
  },
  {
    name: "update with set",
    run: async (c) =>
      (
        await c.entry.update({
          where: { id: "e1" },
          data: { amount: { set: "9" } },
        })
      ).amount,
    expected: "9",
  },
];

describe("decimal exact surface", () => {
  let exact: SurfaceClient;
  let coefficients: SurfaceClient;

  beforeAll(async () => {
    exact = createPGliteClient();
    coefficients = createSQLiteClient();
    for (const client of [exact, coefficients]) {
      await push(client, { force: true });
      await seed(client);
    }
  }, 120_000);

  afterAll(async () => {
    await exact?.$disconnect();
    await coefficients?.$disconnect();
  });

  for (const group of [
    { title: "ordered and derived operations", spellings: SPELLINGS },
    { title: "what the ordering must not change", spellings: CONTROLS },
  ]) {
    describe(group.title, () => {
      for (const { name, run, expected } of group.spellings) {
        test(`${name} — the same exact answer on both`, async () => {
          const fromExact = normalize(await run(exact));
          const fromCoefficients = normalize(await run(coefficients));

          expect(fromCoefficients).toEqual(fromExact);
          if (expected !== undefined) {
            expect(fromExact).toEqual(normalize(expected));
          }
        });
      }
    });
  }
});

/**
 * The SQLite arithmetic guard and the SQLite BIND LIMIT are one fact.
 *
 * `sqlite-adapter.ts` protects its multiply and divide with a flat `10^18`
 * intermediate bound and, when that bound is crossed, writes the sentinel
 * `10^min(precision, 18)` — a coefficient the column's own range CHECK refuses,
 * so the statement dies atomically instead of silently promoting an int64
 * product to REAL. Both halves are only true because plan 3.1's `precision <=
 * 18 && precision + scale <= 18` is PROVEN at schema bind: at 19 digits the
 * sentinel would be a REAL to SQLite's parser AND would fall inside the
 * column's declared range, which is a wrong value written quietly.
 *
 * The two tests below are that dependency, stated where breaking either half
 * fails: the edge descriptor computes exactly and overflows loudly, and one
 * digit past the edge never gets a client at all. `decimal-provider-limits`
 * owns the refusal's own enumeration; this owns the coupling.
 */
const BIND_LIMIT_REFUSAL = /precision \+ scale <= 18/;

describe("the SQLite guard rests on the bind limit", () => {
  /** `precision + scale = 18` exactly: the widest SQLite admits. */
  const EDGE = { precision: 12, scale: 6 } as const;

  const edgeSchema = {
    reading: s
      .model({
        id: s.string().id(),
        amount: s.decimal(EDGE),
      })
      .map("decimal_edge_readings"),
  };

  test("the edge descriptor binds, computes exactly, and overflows LOUDLY", async () => {
    const client = createClient({
      schema: edgeSchema,
      driver: new SQLite3Driver({ dataDir: ":memory:" }),
    });
    try {
      await push(client, { force: true });
      await client.reading.create({
        data: { id: "r1", amount: "1.000005" },
      });

      // Half-even at the field's own scale, on a coefficient one digit inside
      // the guard: 1.000005 x 2 = 2.00001, exact.
      await client.reading.update({
        where: { id: "r1" },
        data: { amount: { multiply: "2" } },
      });
      expect(
        normalize((await client.reading.findUnique({ where: { id: "r1" } }))!)
      ).toEqual({ id: "r1", amount: "2.00001" });

      // The intermediate that CANNOT be evaluated: the domain's largest value
      // times itself needs 24 coefficient digits. The guarded arm is not taken,
      // the sentinel is written, the range CHECK refuses it, and the row is
      // untouched — the loud, atomic failure the flat guard exists to produce.
      await client.reading.update({
        where: { id: "r1" },
        data: { amount: "999999.999999" },
      });
      await expect(
        client.reading.update({
          where: { id: "r1" },
          data: { amount: { multiply: "999999.999999" } },
        })
      ).rejects.toThrow();
      expect(
        normalize((await client.reading.findUnique({ where: { id: "r1" } }))!)
      ).toEqual({ id: "r1", amount: "999999.999999" });
    } finally {
      await client.$disconnect();
    }
  }, 120_000);

  test("one digit past the edge never gets a client to compute with", () => {
    expect(() =>
      createClient({
        schema: {
          reading: s
            .model({
              id: s.string().id(),
              // precision + scale = 19: one past what the guard can bound.
              amount: s.decimal({ precision: 13, scale: 6 }),
            })
            .map("decimal_edge_readings"),
        },
        driver: new SQLite3Driver({ dataDir: ":memory:" }),
      })
    ).toThrow(BIND_LIMIT_REFUSAL);
  });
});
