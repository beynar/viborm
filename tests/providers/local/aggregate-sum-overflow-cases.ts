/**
 * A `_sum` that leaves its type's range answers alone (engine-10, 1.1.0), and
 * every other aggregate of the same call is returned. In 1.1.0 SQLite refused
 * the whole call (V2006 for a number, V2005 for an int64 sum), PostgreSQL
 * raised an overflow (V2005) and MySQL answered a number sum as a silent `0`.
 *
 * A number sum is the provider's double sum computed without intermediate
 * overflow: `Infinity` or `-Infinity` only when the total leaves the double
 * range, so a group whose partial sums leave the range but whose total does
 * not answers that total, on every dialect alike. An ordinary sum is the same
 * double the plain `SUM` answers, and subnormal members are neither lost nor
 * refused. A bigint or decimal sum is exact past the int64 range on every
 * dialect, SQLite's int64 `SUM` included.
 *
 * Shared by the sqlite3, PGlite, pg and mysql2 registrations; deliberately
 * not named `*.test.ts`.
 */
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, onTestFinished, test } from "vitest";

const MAX = Number.MAX_VALUE;
const TINY = Number.MIN_VALUE;

/** One group per question, summed in insertion order. */
const GROUPS = {
  // Past the range upward and downward.
  above: [MAX, MAX, MAX],
  below: [-MAX, -MAX],
  // A running total leaves the range; the arithmetic sum does not.
  returns: [MAX, MAX, -MAX],
  // An ordinary sum is the plain IEEE sum, rounding included.
  ordinary: [0.1, 0.2],
  // Subnormal members are summed, not flushed or refused.
  subnormal: [TINY, TINY],
  mixed: [1e-300, 1.5],
} as const;

const EXPECTED_SUMS = {
  above: Number.POSITIVE_INFINITY,
  below: Number.NEGATIVE_INFINITY,
  returns: MAX,
  ordinary: 0.1 + 0.2,
  subnormal: 2 * TINY,
  mixed: 1.5,
};

const HALF = 2n ** 62n;

/** One account per question about an int64 `_sum` (bigint, decimal). */
const LEDGER = {
  // Two rows suffice to leave the int64 range, upward and downward.
  up: [HALF, HALF],
  down: [-HALF, -HALF, -1n],
  // Members at both int64 ends, whose sum is small.
  ends: [2n ** 63n - 1n, -(2n ** 63n)],
} as const;

/** The widest SQLite decimal a thousand rows overflow the int64 coefficient of. */
const AMOUNT = "99999999999999.99";
const AMOUNT_ROWS = 1000;

/**
 * An `s.int()` column whose `_sum` passes 2^53, as rows the database generates
 * in a view rather than stores: SQLite's members are the widest safe integers
 * and their sum also leaves int64, where SQLite's own integer `SUM` raises;
 * PostgreSQL's and MySQL's `integer` holds at most 2^31 - 1, so 4,194,305 of
 * them. MySQL's default `cte_max_recursion_depth` (1000) rules out a recursive
 * CTE there: its rows are a cross join of digit tables.
 */
const DIGITS = `(SELECT 0 AS d UNION ALL ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => `SELECT ${d}`).join(" UNION ALL ")})`;
const INT_SUM_VIEWS = {
  sqlite: {
    rows: 1100,
    member: Number.MAX_SAFE_INTEGER,
    quote: (name: string) => `"${name}"`,
    create: (view: string, rows: number, member: number) =>
      `CREATE VIEW ${view} AS WITH RECURSIVE g(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM g WHERE i < ${rows}) SELECT i AS id, ${member} AS n FROM g`,
  },
  postgresql: {
    rows: 4_194_305,
    member: 2_147_483_647,
    quote: (name: string) => `"${name}"`,
    create: (view: string, rows: number, member: number) =>
      `CREATE OR REPLACE VIEW ${view} AS SELECT g AS id, ${member} AS n FROM generate_series(1, ${rows}) AS g`,
  },
  mysql: {
    rows: 4_194_305,
    member: 2_147_483_647,
    quote: (name: string) => `\`${name}\``,
    create: (view: string, rows: number, member: number) =>
      `CREATE OR REPLACE VIEW ${view} AS SELECT g.i + 1 AS id, ${member} AS n FROM (SELECT ${[0, 1, 2, 3, 4, 5, 6].map((place) => `t${place}.d * ${10 ** place}`).join(" + ")} AS i FROM ${[0, 1, 2, 3, 4, 5, 6].map((place) => `${DIGITS} AS t${place}`).join(" CROSS JOIN ")}) AS g WHERE g.i < ${rows}`,
  },
} as const;

export function runAggregateSumOverflowCases(options: {
  readonly driverName: string;
  readonly createDriver: () => AnyDriver;
  readonly table: string;
  /** Registers the `s.int()` case past 2^53. */
  readonly intSum?: keyof typeof INT_SUM_VIEWS;
}): void {
  const reading = s
    .model({
      id: s.int().id(),
      sensor: s.string(),
      score: s.number(),
      age: s.int(),
    })
    .map(options.table);

  async function open() {
    const db = createClient({
      schema: { reading },
      driver: options.createDriver(),
    });
    onTestFinished(() => db.$disconnect());
    await syncLiveSchema(db, { tables: [options.table], force: true });
    // A server database outlives the test; an in-memory one starts empty.
    await db.reading.deleteMany({});
    let id = 0;
    await db.reading.createMany({
      data: Object.entries(GROUPS).flatMap(([sensor, scores]) =>
        scores.map((score) => {
          id += 1;
          return { id, sensor, score, age: 10 * id };
        })
      ),
    });
    return db;
  }

  describe(`${options.driverName}: an overflowing number _sum`, () => {
    test("aggregate returns the infinite sum beside the unrelated aggregates", async () => {
      const db = await open();
      expect(
        await db.reading.aggregate({
          where: { sensor: "above" },
          _sum: { score: true, age: true },
          _avg: { age: true },
          _min: { score: true },
          _max: { score: true },
          _count: true,
        })
      ).toEqual({
        _sum: { score: Number.POSITIVE_INFINITY, age: 60 },
        _avg: { age: 20 },
        _min: { score: MAX },
        _max: { score: MAX },
        _count: 3,
      });
    });

    test("groupBy answers each group's sum alone", async () => {
      const db = await open();
      const rows = await db.reading.groupBy({
        by: ["sensor"],
        _sum: { score: true },
        _count: { _all: true },
      });
      expect(
        Object.fromEntries(rows.map((row) => [row.sensor, row._sum.score]))
      ).toEqual(EXPECTED_SUMS);
      expect(
        Object.fromEntries(rows.map((row) => [row.sensor, row._count._all]))
      ).toEqual(
        Object.fromEntries(
          Object.entries(GROUPS).map(([sensor, scores]) => [
            sensor,
            scores.length,
          ])
        )
      );
    });

    test("an empty window still sums to null", async () => {
      const db = await open();
      expect(
        await db.reading.aggregate({
          where: { sensor: "none" },
          _sum: { score: true },
        })
      ).toEqual({ _sum: { score: null } });
    });

    test("a cached infinite sum replays without a second statement", async () => {
      const db = await open();
      const pending: Promise<unknown>[] = [];
      const storage = new MemoryCache();
      const cached = db.$extends(
        cache({ driver: storage, waitUntil: (work) => pending.push(work) })
      );
      onTestFinished(() => storage.disconnect());
      const read = () =>
        cached.$withCache({ ttl: 60_000 }).reading.groupBy({
          by: ["sensor"],
          where: { sensor: { in: ["above", "below"] } },
          _sum: { score: true },
          orderBy: { sensor: "asc" },
        });
      const first = await read();
      await Promise.all(pending.splice(0));
      await db.reading.deleteMany({});
      expect(await read()).toEqual(first);
      expect(first).toEqual([
        { sensor: "above", _sum: { score: Number.POSITIVE_INFINITY } },
        { sensor: "below", _sum: { score: Number.NEGATIVE_INFINITY } },
      ]);
    });
  });

  const ledger = s
    .model({
      id: s.int().id(),
      account: s.string(),
      total: s.bigInt(),
      amount: s.decimal({ precision: 16, scale: 2 }),
      age: s.int(),
    })
    .map(`${options.table}_ledger`);

  async function openLedger() {
    const db = createClient({
      schema: { ledger },
      driver: options.createDriver(),
    });
    onTestFinished(() => db.$disconnect());
    await syncLiveSchema(db, {
      tables: [`${options.table}_ledger`],
      force: true,
    });
    await db.ledger.deleteMany({});
    let id = 0;
    const row = (account: string, total: bigint, amount: string) => {
      id += 1;
      return { id, account, total, amount, age: 10 * id };
    };
    await db.ledger.createMany({
      data: [
        ...Object.entries(LEDGER).flatMap(([account, totals]) =>
          totals.map((total) => row(account, total, "0.01"))
        ),
        ...Array.from({ length: AMOUNT_ROWS }, () => row("bulk", 1n, AMOUNT)),
      ],
    });
    return db;
  }

  describe(`${options.driverName}: an int64 _sum past the int64 range`, () => {
    test("a bigint sum is exact beside the unrelated aggregates", async () => {
      const db = await openLedger();
      expect(
        await db.ledger.aggregate({
          where: { account: "up" },
          _sum: { total: true },
          _avg: { age: true },
          _count: true,
        })
      ).toEqual({ _sum: { total: 2n ** 63n }, _avg: { age: 15 }, _count: 2 });
    });

    test("groupBy answers each account's exact sums", async () => {
      const db = await openLedger();
      const rows = await db.ledger.groupBy({
        by: ["account"],
        _sum: { total: true, amount: true },
        _count: { _all: true },
      });
      expect(
        Object.fromEntries(
          rows.map((row) => [
            row.account,
            [row._sum.total, String(row._sum.amount), row._count._all],
          ])
        )
      ).toEqual({
        up: [2n ** 63n, "0.02", 2],
        down: [-(2n ** 63n) - 1n, "0.03", 3],
        ends: [-1n, "0.02", 2],
        bulk: [BigInt(AMOUNT_ROWS), "99999999999999990", AMOUNT_ROWS],
      });
    });

    test("a cached int64 sum replays without a second statement", async () => {
      const db = await openLedger();
      const pending: Promise<unknown>[] = [];
      const storage = new MemoryCache();
      const cached = db.$extends(
        cache({ driver: storage, waitUntil: (work) => pending.push(work) })
      );
      onTestFinished(() => storage.disconnect());
      const read = () =>
        cached.$withCache({ ttl: 60_000 }).ledger.aggregate({
          where: { account: { in: ["up", "bulk"] } },
          _sum: { total: true, amount: true },
        });
      const first = await read();
      await Promise.all(pending.splice(0));
      await db.ledger.deleteMany({});
      expect(await read()).toEqual(first);
      expect(first._sum.total).toBe(2n ** 63n + BigInt(AMOUNT_ROWS));
    });
  });

  const intSum = options.intSum && INT_SUM_VIEWS[options.intSum];
  if (!intSum) return;
  const name = `${options.table}_int`;
  const view = intSum.quote(name);
  const tally = s.model({ id: s.int().id(), n: s.int() }).map(name);
  const exact = Number(BigInt(intSum.rows) * BigInt(intSum.member));

  describe(`${options.driverName}: an int _sum past 2^53`, () => {
    test("is the provider's sum as the nearest double, beside the other aggregates, and replays from the cache", async () => {
      const db = createClient({
        schema: { tally },
        driver: options.createDriver(),
      });
      // A server database outlives the test: the view goes whatever the outcome.
      onTestFinished(async () => {
        try {
          await db.$executeRawUnsafe(`DROP VIEW IF EXISTS ${view}`);
        } finally {
          await db.$disconnect();
        }
      });
      await db.$executeRawUnsafe(
        intSum.create(view, intSum.rows, intSum.member)
      );
      const pending: Promise<unknown>[] = [];
      const storage = new MemoryCache();
      const cached = db.$extends(
        cache({ driver: storage, waitUntil: (work) => pending.push(work) })
      );
      onTestFinished(() => storage.disconnect());
      const read = () =>
        cached.$withCache({ ttl: 60_000 }).tally.aggregate({
          _sum: { n: true },
          _max: { n: true },
          _count: true,
        });
      const first = await read();
      expect(first).toEqual({
        _sum: { n: exact },
        _max: { n: intSum.member },
        _count: intSum.rows,
      });
      expect(Number.isSafeInteger(first._sum.n)).toBe(false);
      await Promise.all(pending.splice(0));
      // The replay reads no table: the view is gone.
      await db.$executeRawUnsafe(`DROP VIEW ${view}`);
      expect(await read()).toEqual(first);
    }, 60_000);
  });
}
