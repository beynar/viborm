/**
 * The decimal refusal, enumerated over the whole ORDERING surface.
 *
 * The refusal contract (docs/content/docs/schema/scalars/decimal.mdx, and the
 * capability matrix) says a dialect with no exact decimal type REFUSES every
 * ordered or derived decimal operation. That is a claim about a *surface*, not
 * about one call site — and it was false: the gate lived on `findMany({
 * orderBy })` while `findMany({ orderBy, take })`, `findFirst`, cursor
 * pagination, relation `orderBy`, nested-read `orderBy`, `groupBy`'s `orderBy`
 * and `groupBy`'s aggregate `having` all bypassed it and answered
 * lexicographically. `take` is the ordinary spelling of a sorted list, so the
 * refusal was absent exactly where callers write it.
 *
 * So this file enumerates the surface instead of the call sites, and every
 * entry is run TWICE:
 *
 *  - on PGlite (exact decimals) it must RESOLVE. Without this half the suite
 *    would be theater: a misspelled query throws too, and a refusal assertion
 *    over an invalid query proves nothing.
 *  - on SQLite3 (no exact decimals) it must reject with
 *    `UnsupportedOperationError`.
 *
 * The CONTROLS run the same way and must resolve on BOTH — they pin the other
 * half of the contract, that reads, equality, `_count` and `set` stay allowed.
 * Without them a gate that refused everything would pass.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { UnsupportedOperationError } from "@errors";
import { push } from "@migrations";
import { s } from "@schema";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const account = s
  .model({
    id: s.string().id(),
    fee: s.decimal(),
    entries: s.oneToMany(() => entry),
  })
  .map("decimal_surface_accounts");

const entry = s
  .model({
    id: s.string().id(),
    bucket: s.string(),
    amount: s.decimal(),
    accountId: s.string(),
    account: s
      .manyToOne(() => account)
      .fields("accountId")
      .references("id"),
  })
  .map("decimal_surface_entries");

/** A decimal PRIMARY KEY: it becomes the pagination tie-breaker unasked. */
const token = s
  .model({
    serial: s.decimal().id(),
    label: s.string(),
  })
  .map("decimal_surface_tokens");

/** A decimal UNIQUE key: legal as a `cursor`, appended as a tie-breaker. */
const coupon = s
  .model({
    id: s.string().id(),
    faceValue: s.decimal().unique(),
  })
  .map("decimal_surface_coupons");

const schema = { account, entry, token, coupon };

type SurfaceClient = ReturnType<typeof createPGliteClient>;

const createPGliteClient = () =>
  createClient({ schema, driver: new PGliteDriver({ client: new PGlite() }) });

const createSQLiteClient = () =>
  createClient({ schema, driver: new SQLite3Driver({ dataDir: ":memory:" }) });

/**
 * Values chosen so a lexicographic answer differs from the numeric one:
 * "9" sorts after "10" as text, and 1.000…001 collapses onto 1 in a double.
 */
const seed = async (client: SurfaceClient): Promise<void> => {
  await client.account.create({ data: { id: "a-hi", fee: "9" } });
  await client.account.create({ data: { id: "a-lo", fee: "10" } });

  const entries = [
    { id: "e1", bucket: "b", amount: "9", accountId: "a-hi" },
    { id: "e2", bucket: "b", amount: "10", accountId: "a-lo" },
    { id: "e3", bucket: "c", amount: "1", accountId: "a-hi" },
    {
      id: "e4",
      bucket: "c",
      amount: "1.000000000000000000000000000001",
      accountId: "a-lo",
    },
  ];
  for (const row of entries) {
    await client.entry.create({ data: row });
  }

  await client.token.create({ data: { serial: "9", label: "nine" } });
  await client.token.create({ data: { serial: "10", label: "ten" } });

  await client.coupon.create({ data: { id: "c1", faceValue: "9" } });
  await client.coupon.create({ data: { id: "c2", faceValue: "10" } });
};

type Spelling = {
  name: string;
  /** `PromiseLike`, not `Promise`: client calls return a thenable builder. */
  run: (client: SurfaceClient) => PromiseLike<unknown>;
};

/**
 * Every public spelling that puts a decimal into an ORDER BY expression or
 * into an ordered/derived aggregate. Each one is a question SQLite cannot
 * answer exactly, so each one must be refused rather than answered.
 */
const REFUSED: Spelling[] = [
  // --- ordering, unwindowed (the gate that already existed) ---
  {
    name: "findMany orderBy",
    run: (c) => c.entry.findMany({ orderBy: { amount: "asc" } }),
  },
  // --- ordering, windowed: the ordinary spelling of a sorted list ---
  {
    name: "findMany orderBy + take",
    run: (c) => c.entry.findMany({ orderBy: { amount: "desc" }, take: 2 }),
  },
  {
    name: "findMany orderBy + negative take",
    run: (c) => c.entry.findMany({ orderBy: { amount: "asc" }, take: -2 }),
  },
  {
    name: "findMany orderBy + skip + take",
    run: (c) =>
      c.entry.findMany({ orderBy: { amount: "asc" }, skip: 1, take: 2 }),
  },
  {
    name: "findMany orderBy + cursor",
    run: (c) =>
      c.entry.findMany({
        orderBy: { amount: "asc" },
        cursor: { id: "e1" },
        take: 2,
      }),
  },
  {
    name: "findMany orderBy nulls placement + take",
    run: (c) =>
      c.entry.findMany({
        orderBy: { amount: { sort: "asc", nulls: "last" } },
        take: 2,
      }),
  },
  {
    name: "findFirst orderBy",
    run: (c) => c.entry.findFirst({ orderBy: { amount: "desc" } }),
  },
  // --- the decimal is never named: it arrives as a tie-breaker ---
  {
    name: "take on a model whose primary key is a decimal",
    run: (c) => c.token.findMany({ take: 1 }),
  },
  {
    name: "cursor on a unique decimal key",
    run: (c) => c.coupon.findMany({ cursor: { faceValue: "9" }, take: 1 }),
  },
  // --- ordering one hop away ---
  {
    name: "findMany orderBy through a to-one relation",
    run: (c) => c.entry.findMany({ orderBy: { account: { fee: "asc" } } }),
  },
  {
    name: "findMany orderBy through a to-one relation + take",
    run: (c) =>
      c.entry.findMany({ orderBy: { account: { fee: "asc" } }, take: 2 }),
  },
  // --- ordering inside a nested read window ---
  {
    name: "include with a nested orderBy",
    run: (c) =>
      c.account.findMany({
        include: { entries: { orderBy: { amount: "asc" } } },
      }),
  },
  {
    name: "include with a nested orderBy + take",
    run: (c) =>
      c.account.findMany({
        include: { entries: { orderBy: { amount: "asc" }, take: 1 } },
      }),
  },
  // --- aggregate windows (count/aggregate share the pagination window) ---
  {
    name: "count with orderBy + take",
    run: (c) => c.entry.count({ orderBy: { amount: "asc" }, take: 2 }),
  },
  {
    name: "aggregate with orderBy + take",
    run: (c) =>
      c.entry.aggregate({
        _count: true,
        orderBy: { amount: "asc" },
        take: 2,
      }),
  },
  // --- selected aggregates (the gate that already existed) ---
  {
    name: "aggregate _max",
    run: (c) => c.entry.aggregate({ _max: { amount: true } }),
  },
  {
    name: "groupBy selecting _sum",
    run: (c) => c.entry.groupBy({ by: ["bucket"], _sum: { amount: true } }),
  },
  // --- groupBy ordering ---
  {
    name: "groupBy orderBy a grouped decimal",
    run: (c) =>
      c.entry.groupBy({
        by: ["amount"],
        orderBy: { amount: "asc" },
        _count: true,
      }),
  },
  {
    name: "groupBy orderBy _max",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        orderBy: { _max: { amount: "desc" } },
        _count: true,
      }),
  },
  {
    name: "groupBy orderBy _sum",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        orderBy: { _sum: { amount: "desc" } },
        _count: true,
      }),
  },
  {
    name: "groupBy orderBy _avg",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        orderBy: { _avg: { amount: "desc" } },
        _count: true,
      }),
  },
  {
    name: "groupBy orderBy _min",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        orderBy: { _min: { amount: "asc" } },
        _count: true,
      }),
  },
  // --- groupBy having, every ordered aggregate ---
  {
    name: "groupBy having _max",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { amount: { _max: { gt: 5 } } },
        _count: true,
      }),
  },
  {
    name: "groupBy having _min",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { amount: { _min: { lt: 5 } } },
        _count: true,
      }),
  },
  {
    name: "groupBy having _sum",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { amount: { _sum: { gt: 5 } } },
        _count: true,
      }),
  },
  {
    name: "groupBy having _avg",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { amount: { _avg: { gte: 5 } } },
        _count: true,
      }),
  },
  {
    name: "groupBy having _sum nested under NOT",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { NOT: [{ amount: { _sum: { gt: 5 } } }] },
        _count: true,
      }),
  },
  // --- ordered comparisons and arithmetic (the gates that already existed) ---
  {
    name: "where gt",
    run: (c) => c.entry.findMany({ where: { amount: { gt: "5" } } }),
  },
  {
    name: "where gt through a relation",
    run: (c) => c.entry.findMany({ where: { account: { fee: { gt: "5" } } } }),
  },
  {
    name: "having on a grouped decimal with gt",
    run: (c) =>
      c.entry.groupBy({
        by: ["amount"],
        having: { amount: { gt: "5" } },
        _count: true,
      }),
  },
  {
    name: "update with increment",
    run: (c) =>
      c.entry.update({
        where: { id: "e1" },
        data: { amount: { increment: 1 } },
      }),
  },
];

/**
 * What must KEEP working on a dialect with no exact decimal type. Storage,
 * reads, equality and row counting need no ordering, so refusing them would be
 * a false refusal — and a gate that refuses everything is not a gate.
 */
const ALLOWED: Spelling[] = [
  {
    name: "findMany, no ordering",
    run: (c) => c.entry.findMany(),
  },
  {
    name: "findMany orderBy a non-decimal + take",
    run: (c) => c.entry.findMany({ orderBy: { bucket: "asc" }, take: 2 }),
  },
  {
    name: "findMany where equals",
    run: (c) => c.entry.findMany({ where: { amount: "9" } }),
  },
  {
    name: "findMany where in",
    run: (c) => c.entry.findMany({ where: { amount: { in: ["9", "10"] } } }),
  },
  {
    name: "findMany distinct on a decimal",
    run: (c) => c.entry.findMany({ distinct: ["amount"] }),
  },
  {
    name: "findUnique by a decimal primary key",
    run: (c) => c.token.findUnique({ where: { serial: "9" } }),
  },
  {
    name: "count",
    run: (c) => c.entry.count(),
  },
  {
    name: "aggregate _count over a decimal column",
    run: (c) => c.entry.aggregate({ _count: { amount: true } }),
  },
  {
    name: "groupBy a decimal, unordered",
    run: (c) => c.entry.groupBy({ by: ["amount"], _count: true }),
  },
  {
    name: "groupBy orderBy _count of a decimal column",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        orderBy: { _count: { amount: "desc" } },
        _count: true,
      }),
  },
  {
    name: "groupBy having _count of a decimal column",
    run: (c) =>
      c.entry.groupBy({
        by: ["bucket"],
        having: { amount: { _count: { gt: 1 } } },
        _count: true,
      }),
  },
  {
    name: "update with set",
    run: (c) =>
      c.entry.update({ where: { id: "e3" }, data: { amount: { set: "2" } } }),
  },
];

describe("decimal refusal surface", () => {
  let exact: SurfaceClient;
  let inexact: SurfaceClient;

  beforeAll(async () => {
    exact = createPGliteClient();
    inexact = createSQLiteClient();
    for (const client of [exact, inexact]) {
      await push(client, { force: true });
      await seed(client);
    }
  });

  afterAll(async () => {
    await exact?.$disconnect();
    await inexact?.$disconnect();
  });

  describe("ordered and derived operations", () => {
    for (const { name, run } of REFUSED) {
      test(`${name} — answered exactly where decimals are exact`, async () => {
        // Proves the spelling is REAL. A refusal over a query that would have
        // thrown anyway is not evidence of anything.
        await expect(run(exact)).resolves.toBeDefined();
      });

      test(`${name} — REFUSED where they are not`, async () => {
        await expect(run(inexact)).rejects.toThrow(UnsupportedOperationError);
      });
    }
  });

  describe("what stays allowed", () => {
    for (const { name, run } of ALLOWED) {
      test(`${name} — answered on both`, async () => {
        await expect(run(exact)).resolves.toBeDefined();
        await expect(run(inexact)).resolves.toBeDefined();
      });
    }
  });
});
