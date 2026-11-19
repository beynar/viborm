/**
 * Aggregated views (`s.view(() => source, { by, … })`) on SurrealDB, against
 * a server: `DEFINE TABLE <view> AS SELECT <by fields>, <aggregates> FROM
 * <source> [WHERE …] GROUP BY <by fields>`, which the database keeps current
 * for every write to its source. A push defines each view and a second plans
 * nothing; each row is what groupBy answers on the source, through every
 * write to it, a group that empties included; the view reads as a table, by
 * its key (its `by` list, which ids its rows), across a relation from a
 * grouped column, and under and over other views; a query SurrealDB cannot
 * keep current is refused with the view named. Gated on SURREAL_TEST_URL.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { UnsupportedOperationError } from "@errors";
import { createMigrationClient } from "@migrations/dialects/surrealql";
import { getMigrationDriver } from "@migrations/drivers";
import type { ResolveCallback } from "@migrations/types";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { Decimal } from "@src/index";
import {
  createSurrealTestDriver,
  surrealUrl,
} from "@tests/fixtures/drivers/surrealdb";
import { describe, expect, it } from "vitest";

type Client = any;

const store = s
  .model({
    id: s.int().id(),
    name: s.string(),
    sales: s.toMany(() => sale),
    totals: s.toOne(() => byStore),
  })
  .map("sa_stores");
const sale = s
  .model({
    id: s.string().id(),
    storeId: s.int(),
    currency: s.enum(["EUR", "USD"]),
    region: s.string().nullable(),
    units: s.int(),
    qty: s.int().nullable(),
    big: s.bigInt(),
    ratio: s.number(),
    amount: s.decimal({ precision: 10, scale: 2 }),
    rate: s.decimal({ precision: 12, scale: 4 }).nullable(),
    label: s.string().map("sale_label"),
    soldAt: s.dateTime(),
    shippedAt: s.dateTime().nullable(),
    store: s
      .toOne(() => store)
      .fields("storeId")
      .references("id"),
  })
  .map("sa_sales");

/** Every aggregate SurrealDB keeps, over every field type it keeps it for. */
const totalsQuery = {
  by: ["storeId", "currency"],
  where: { units: { gte: 0 } },
  _count: { _all: true, region: true },
  _sum: { units: true, qty: true, big: true, amount: true, rate: true },
  _avg: { units: true, qty: true, big: true, amount: true, rate: true },
  _min: {
    units: true,
    qty: true,
    big: true,
    ratio: true,
    amount: true,
    soldAt: true,
    shippedAt: true,
  },
  _max: { units: true, big: true, ratio: true, rate: true, soldAt: true },
} as const;
const totals = s.view(() => sale, totalsQuery).map("sa_totals");
/** One grouped field: the view's key alone, and a relation from it. */
const byStoreQuery = {
  by: ["storeId"],
  _sum: { amount: true, units: true },
} as const;
const byStore = s
  .view(() => sale, byStoreQuery)
  .extends({
    store: s
      .toOne(() => store)
      .fields("storeId")
      .references("id"),
    budgets: s.toMany(() => budget),
  })
  .map("sa_by_store");
/** A table whose column names the view's key. */
const budget = s
  .model({
    id: s.int().id(),
    storeRef: s.int(),
    totals: s
      .toOne(() => byStore)
      .fields("storeRef")
      .references("storeId"),
  })
  .map("sa_budgets");
/** A nullable grouped field: no key. */
const byRegionQuery = { by: "region", _count: true } as const;
const byRegion = s.view(() => sale, byRegionQuery).map("sa_by_region");

const schema = { store, sale, budget, totals, byStore, byRegion };

/** What each body is: the grouped fields, each aggregate as groupBy reads it. */
const TOTALS_BODY = [
  "DEFINE TABLE sa_totals AS SELECT <int> record::id(storeId) AS storeId, currency, count() AS count, count(region != NONE) AS countRegion",
  "math::mean(units) AS avgUnits, (IF count(qty != NONE) = 0 { NULL } ELSE { math::mean(qty) }) AS avgQty",
  "math::mean(<decimal> big) AS avgBig, (math::round(math::mean(amount) * 100dec) / 100dec) AS avgAmount",
  "(IF count(rate != NONE) = 0 { NULL } ELSE { (math::round(math::mean(rate) * 10000dec) / 10000dec) }) AS avgRate",
  "math::sum(units) AS sumUnits, (IF count(qty != NONE) = 0 { NULL } ELSE { math::sum(qty) }) AS sumQty",
  "math::sum(<decimal> big) AS sumBig, math::sum(amount) AS sumAmount",
  "(IF count(rate != NONE) = 0 { NULL } ELSE { math::sum(rate) }) AS sumRate, math::min(units) AS minUnits",
  "(IF count(qty != NONE) = 0 { NULL } ELSE { math::min(qty) }) AS minQty, math::min(big) AS minBig",
  "math::min(ratio) AS minRatio, math::min(amount) AS minAmount, time::min(soldAt) AS minSoldAt",
  "(IF count(shippedAt != NONE) = 0 { NULL } ELSE { time::min(shippedAt) }) AS minShippedAt",
  "math::max(units) AS maxUnits, math::max(big) AS maxBig, math::max(ratio) AS maxRatio",
  '(IF count(rate != NONE) = 0 { NULL } ELSE { math::max(rate) }) AS maxRate, time::max(soldAt) AS maxSoldAt FROM sa_sales WHERE id != NONE AND (units >= 0) GROUP BY storeId, currency COMMENT "viborm_view_…";',
].join(", ");
const BY_REGION_BODY =
  'DEFINE TABLE sa_by_region AS SELECT region, count() AS count FROM sa_sales GROUP BY region COMMENT "viborm_view_…";';
const MARKER = /viborm_view_[0-9a-f]{40}/;
const NO_KEY = /view that projects no key/;
const HAVING =
  /View 'bad' cannot be created from a query that keeps the groups a having holds: SurrealDB keeps a view's groups current from its source's rows and has no filter of the groups themselves/;
const WINDOW = /View 'bad' cannot be created from a query that takes a window/;
const SKIPS = /View 'bad' cannot be created from a query that skips rows/;
const ORDER = /View 'bad' cannot be created from a query that orders its rows/;
const STEP =
  /View 'bad' cannot be created from a query that groups by a time step: groupBy reads no time step on SurrealDB/;
const DOUBLE_SUM =
  /View 'bad' cannot be created from a query that sums the double 'ratio': SurrealDB keeps a view's sum by adding and subtracting each write/;
const DOUBLE_AVG = /that averages the double 'ratio'/;
const STRING_MIN =
  /View 'bad' cannot be created from a query that takes the least 'label', which is no number and no dateTime: SurrealDB keeps a view's least and greatest values current for numbers/;
const ENUM_MAX =
  /that takes the greatest 'currency', which is no number and no dateTime/;
const KEY_MIN =
  /View 'bad' cannot be created from a query that takes the least 'id', which holds a record: a key or a link is a record there/;
const LINK_SUM = /that sums 'storeId', which holds a record/;
const RELATION_FILTER =
  /View 'bad' cannot be created from a query that filters through a relation/;

/** A driver on a database of its own. */
async function freshDriver(): Promise<AnyDriver> {
  const driver = createSurrealTestDriver();
  await (driver as unknown as { fresh(): Promise<void> }).fresh();
  return driver as never;
}

const clientOf = (shape: object, driver: AnyDriver): Client =>
  createClient({ schema: shape as never, driver: driver as never });

const resolve: ResolveCallback = (change) => {
  if (change.type === "ambiguous") return change.rename();
  if (change.type === "destructive") return change.proceed();
  return undefined;
};

async function push(client: Client) {
  const migrations = createMigrationClient(client);
  const preview = await migrations.push({ dryRun: true, resolve });
  const result = await migrations.push({ consent: preview.consent, resolve });
  return {
    labels: result.operations.map(({ label }: { label: string }) => label),
    statements: preview.statements.map(({ sql }: { sql: string }) => sql),
  };
}

async function using(client: Client, body: () => Promise<void>) {
  try {
    await body();
  } finally {
    await client.$disconnect();
  }
}

/** A value as data to compare: a `Decimal` has no own property. */
function plain(value: unknown): unknown {
  if (value instanceof Decimal) return `decimal:${value.toString()}`;
  if (value instanceof Date) return `date:${value.toISOString()}`;
  if (typeof value === "bigint") return `bigint:${value}`;
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, member]) => [key, plain(member)])
    );
  return value;
}

/** Rows compared whatever their order and the order of their keys. */
const unordered = (rows: readonly unknown[]) =>
  rows
    .map((row) =>
      JSON.stringify(
        Object.entries(plain(row) as object).sort(([left], [right]) =>
          left < right ? -1 : 1
        )
      )
    )
    .sort();

/** A `groupBy` row as an aggregated view holds it: each aggregate a column. */
function flattened(row: object): Record<string, unknown> {
  const columns: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (!key.startsWith("_")) columns[key] = value;
    else if (typeof value !== "object" || value === null)
      columns[key.slice(1)] = value;
    else
      for (const [field, member] of Object.entries(value))
        columns[
          field === "_all"
            ? key.slice(1)
            : `${key.slice(1)}${field.charAt(0).toUpperCase()}${field.slice(1)}`
        ] = member;
  }
  return columns;
}

/** `by` as `groupBy` takes it: a mutable list. */
const grouping = <Q extends { readonly by: readonly unknown[] }>(query: Q) => ({
  ...query,
  by: [...query.by] as Q["by"][number][],
});

const SALES = [
  // id, store, currency, region, units, qty, big, ratio, amount, rate, label, soldAt, shippedAt
  [
    "s1",
    1,
    "EUR",
    "eu",
    3,
    4,
    9_007_199_254_740_993n,
    0.5,
    "10.25",
    "1.1234",
    "b",
    "2024-03-01T23:30:00.000Z",
    null,
  ],
  [
    "s2",
    1,
    "EUR",
    null,
    2,
    null,
    7n,
    0.25,
    "5.00",
    null,
    "a",
    "2024-03-01T10:00:00.000Z",
    "2024-03-04T10:00:00.000Z",
  ],
  [
    "s3",
    1,
    "USD",
    "us",
    1,
    null,
    -3n,
    1.5,
    "99.99",
    "2.5000",
    "c",
    "2024-03-02T12:00:00.000Z",
    null,
  ],
  [
    "s4",
    2,
    "EUR",
    "eu",
    5,
    1,
    0n,
    -2.75,
    "-1.00",
    "3.3333",
    "d",
    "2024-03-02T22:59:59.000Z",
    null,
  ],
  [
    "s5",
    2,
    "EUR",
    null,
    4,
    2,
    100n,
    0.125,
    "0.01",
    "1.0000",
    "e",
    "2024-03-02T23:00:00.000Z",
    "2024-03-05T00:00:00.000Z",
  ],
  [
    "s6",
    2,
    "USD",
    "us",
    0,
    7,
    1n,
    3,
    "1234.56",
    "0.5000",
    "f",
    "2024-03-03T00:00:00.000Z",
    null,
  ],
] as const;

async function seed(client: Client) {
  await client.store.createMany({
    data: [
      { id: 1, name: "North" },
      { id: 2, name: "South" },
      { id: 3, name: "Empty" },
    ],
  });
  for (const [
    id,
    storeId,
    currency,
    region,
    units,
    qty,
    big,
    ratio,
    amount,
    rate,
    label,
    soldAt,
    shippedAt,
  ] of SALES)
    await client.sale.create({
      data: {
        id,
        storeId,
        currency,
        region,
        units,
        qty,
        big,
        ratio,
        amount,
        rate,
        label,
        soldAt: new Date(soldAt),
        shippedAt: shippedAt === null ? null : new Date(shippedAt),
      },
    });
}

describe.skipIf(!surrealUrl)("aggregated views on SurrealDB", () => {
  it("a push defines each as a grouped table the database computes, and a second push plans nothing", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      const { labels, statements } = await push(client);
      expect(labels).toEqual([
        '+ Create table "sa_stores" with 2 columns',
        '+ Create table "sa_sales" with 13 columns',
        '+ Create table "sa_budgets" with 2 columns',
        '+ Create view "sa_totals"',
        '+ Create view "sa_by_store"',
        '+ Create view "sa_by_region"',
      ]);
      const bodies = statements
        .filter((statement: string) => statement.includes(" AS SELECT "))
        .map((statement: string) => statement.replace(MARKER, "viborm_view_…"));
      expect(bodies).toContain(TOTALS_BODY);
      expect(bodies).toContain(BY_REGION_BODY);
      expect(await createMigrationClient(client).push()).toMatchObject({
        outcome: "noop",
        operations: [],
      });
      const snapshot = await getMigrationDriver(driver).introspect(
        (statement, parameters) => driver._executeRaw(statement, parameters)
      );
      expect(
        (snapshot.views ?? []).map(({ name, dependsOn }) => [name, dependsOn])
      ).toEqual([
        ["sa_by_region", ["sa_sales"]],
        ["sa_by_store", ["sa_sales"]],
        ["sa_totals", ["sa_sales"]],
      ]);
    });
  });

  it("a row is what groupBy answers on the source, each aggregate a column of its scalar", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const grouped = await client.sale.groupBy(grouping(totalsQuery));
      const rows = await client.totals.findMany();
      expect(rows).toHaveLength(4);
      expect(unordered(rows)).toEqual(unordered(grouped.map(flattened)));
      const north = rows.find(
        (row: { storeId: number; currency: string }) =>
          row.storeId === 1 && row.currency === "EUR"
      );
      // A decimal average lands on the field's scale half to even, as
      // groupBy's does; a bigint sum is a bigint; a group of no value is null.
      expect(plain(north)).toEqual(
        plain({
          storeId: 1,
          currency: "EUR",
          count: 2,
          countRegion: 1,
          avgUnits: 2.5,
          avgQty: 4,
          avgBig: 4_503_599_627_370_500,
          avgAmount: new Decimal("7.62"),
          avgRate: new Decimal("1.1234"),
          sumUnits: 5,
          sumQty: 4,
          sumBig: 9_007_199_254_741_000n,
          sumAmount: new Decimal("15.25"),
          sumRate: new Decimal("1.1234"),
          minUnits: 2,
          minQty: 4,
          minBig: 7n,
          minRatio: 0.25,
          minAmount: new Decimal("5"),
          minSoldAt: new Date("2024-03-01T10:00:00.000Z"),
          minShippedAt: new Date("2024-03-04T10:00:00.000Z"),
          maxUnits: 3,
          maxBig: 9_007_199_254_740_993n,
          maxRatio: 0.5,
          maxRate: new Decimal("1.1234"),
          maxSoldAt: new Date("2024-03-01T23:30:00.000Z"),
        })
      );
      const usd = rows.find(
        (row: { storeId: number; currency: string }) =>
          row.storeId === 1 && row.currency === "USD"
      );
      expect(usd).toMatchObject({ sumQty: null, avgQty: null, minQty: null });
      expect(unordered(await client.byRegion.findMany())).toEqual(
        unordered(
          (
            await client.sale.groupBy(
              grouping({ by: ["region"], _count: true })
            )
          ).map(flattened)
        )
      );
      expect(unordered(await client.byStore.findMany())).toEqual(
        unordered(
          (await client.sale.groupBy(grouping(byStoreQuery))).map(flattened)
        )
      );
    });
  });

  it("follows every write to its source: an aggregate, a grouped field, a filtered field, and a group that empties", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const current = async () => {
        expect(unordered(await client.totals.findMany())).toEqual(
          unordered(
            (await client.sale.groupBy(grouping(totalsQuery))).map(flattened)
          )
        );
        expect(unordered(await client.byStore.findMany())).toEqual(
          unordered(
            (await client.sale.groupBy(grouping(byStoreQuery))).map(flattened)
          )
        );
        expect(unordered(await client.byRegion.findMany())).toEqual(
          unordered(
            (
              await client.sale.groupBy(
                grouping({ by: ["region"], _count: true })
              )
            ).map(flattened)
          )
        );
      };
      // An aggregated field, the least and greatest values included.
      await client.sale.update({
        where: { id: "s2" },
        data: { units: 9, amount: "0.50", soldAt: new Date("2020-01-01") },
      });
      await current();
      // A grouped field: the row leaves one group for another.
      await client.sale.update({
        where: { id: "s1" },
        data: { currency: "USD", region: null },
      });
      await current();
      // A filtered field: the row leaves the view's rows, then comes back.
      await client.sale.update({ where: { id: "s6" }, data: { units: -1 } });
      await current();
      await client.sale.update({ where: { id: "s6" }, data: { units: 2 } });
      await current();
      // A new group, then its last row goes, and the group with it.
      await client.sale.create({
        data: {
          id: "s7",
          storeId: 3,
          currency: "EUR",
          units: 1,
          big: 1n,
          ratio: 1,
          amount: "1",
          label: "g",
          soldAt: new Date("2024-03-09"),
        },
      });
      await current();
      expect(await client.byStore.count()).toBe(3);
      await client.sale.delete({ where: { id: "s7" } });
      await current();
      expect(
        await client.byStore.findUnique({ where: { storeId: 3 } })
      ).toBeNull();
      await client.sale.deleteMany({ where: { storeId: 2 } });
      await current();
      expect(await client.byStore.count()).toBe(1);
    });
  });

  it("reads as a table: a filter, an order, a page, count, aggregate and groupBy read each column as its scalar", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const grouped = (await client.sale.groupBy(grouping(totalsQuery))).map(
        flattened
      ) as { sumAmount: Decimal; sumUnits: number }[];
      const over = await client.totals.findMany({
        where: { sumAmount: { gt: "10" }, count: { gte: 1 } },
        orderBy: { sumUnits: "desc" },
        select: { storeId: true, currency: true, sumUnits: true },
      });
      expect(
        over.map(({ sumUnits }: { sumUnits: number }) => sumUnits)
      ).toEqual(
        grouped
          .filter(({ sumAmount }) => sumAmount.gt("10"))
          .map(({ sumUnits }) => sumUnits)
          .sort((left, right) => right - left)
      );
      expect(
        plain(
          await client.totals.aggregate({
            _max: { sumAmount: true, maxSoldAt: true },
            _sum: { count: true, sumBig: true },
            _min: { minSoldAt: true },
          })
        )
      ).toEqual(
        plain({
          _max: {
            sumAmount: new Decimal("1234.56"),
            maxSoldAt: new Date("2024-03-03T00:00:00.000Z"),
          },
          _sum: { count: 6, sumBig: 9_007_199_254_741_098n },
          _min: { minSoldAt: new Date("2024-03-01T10:00:00.000Z") },
        })
      );
      expect(
        unordered(
          await client.totals.groupBy({
            by: ["currency"],
            _sum: { count: true },
          })
        )
      ).toEqual(
        unordered([
          { currency: "EUR", _sum: { count: 4 } },
          { currency: "USD", _sum: { count: 2 } },
        ])
      );
      // A grouped field is read from the group's id, where it is filtered,
      // ordered and paged by.
      expect(
        await client.totals.findMany({
          where: { storeId: 2, currency: { in: ["EUR"] } },
          select: { storeId: true, currency: true, count: true },
        })
      ).toEqual([{ storeId: 2, currency: "EUR", count: 2 }]);
      expect(await client.totals.count({ where: { currency: "USD" } })).toBe(2);
      expect(
        await client.totals.findMany({
          orderBy: [{ storeId: "desc" }, { currency: "asc" }],
          select: { storeId: true, currency: true },
        })
      ).toEqual([
        { storeId: 2, currency: "EUR" },
        { storeId: 2, currency: "USD" },
        { storeId: 1, currency: "EUR" },
        { storeId: 1, currency: "USD" },
      ]);
      expect(
        await client.totals.findMany({
          cursor: { storeId_currency: { storeId: 1, currency: "USD" } },
          skip: 1,
          take: 2,
          select: { storeId: true, currency: true },
        })
      ).toEqual([
        { storeId: 2, currency: "EUR" },
        { storeId: 2, currency: "USD" },
      ]);
      expect(
        await client.byRegion.findMany({
          where: { region: null },
          select: { region: true, count: true },
        })
      ).toEqual([{ region: null, count: 2 }]);
      expect(
        await client.byRegion.findFirst({
          orderBy: { region: "asc" },
          select: { region: true },
        })
      ).toEqual({ region: "eu" });
    });
  });

  it("its key is its by list: findUnique by the compound key or the one field; grouped by a nullable field it has none", async () => {
    // A double is a float in the group's id, which an integral value names
    // as an int.
    const byRatio = s
      .view(() => sale, { by: ["ratio"], _count: true })
      .map("sa_by_ratio");
    const driver = await freshDriver();
    const client = clientOf({ ...schema, byRatio }, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      expect(
        await client.totals.findUnique({
          where: { storeId_currency: { storeId: 1, currency: "EUR" } },
          select: { count: true, sumUnits: true },
        })
      ).toEqual({ count: 2, sumUnits: 5 });
      expect(
        await client.totals.findUnique({
          where: { storeId_currency: { storeId: 3, currency: "EUR" } },
        })
      ).toBeNull();
      expect(
        plain(await client.byStore.findUnique({ where: { storeId: 2 } }))
      ).toEqual(
        plain({ storeId: 2, sumAmount: new Decimal("1233.57"), sumUnits: 9 })
      );
      await expect(
        client.byRegion.findUnique({ where: { region: "eu" } })
      ).rejects.toThrow(NO_KEY);
      expect(await client.byRatio.findUnique({ where: { ratio: 3 } })).toEqual({
        ratio: 3,
        count: 1,
      });
      expect(
        await client.byRatio.findUnique({ where: { ratio: 0.5 } })
      ).toEqual({ ratio: 0.5, count: 1 });
    });
  });

  it("a relation from a grouped column, and one from a table's column to the view's key, read as the relation between tables, both ways", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      expect(
        await client.byStore.findMany({
          include: { store: { select: { name: true } } },
          orderBy: { storeId: "asc" },
          select: undefined,
        })
      ).toMatchObject([
        { storeId: 1, store: { name: "North" } },
        { storeId: 2, store: { name: "South" } },
      ]);
      expect(
        await client.byStore.findMany({
          where: { store: { name: "South" } },
          select: { storeId: true },
        })
      ).toEqual([{ storeId: 2 }]);
      expect(
        await client.store.findMany({
          orderBy: { id: "asc" },
          select: { id: true, totals: { select: { sumUnits: true } } },
        })
      ).toEqual([
        { id: 1, totals: { sumUnits: 6 } },
        { id: 2, totals: { sumUnits: 9 } },
        { id: 3, totals: null },
      ]);
      expect(
        await client.store.findMany({
          where: { totals: { sumUnits: { gt: 6 } } },
          select: { id: true },
        })
      ).toEqual([{ id: 2 }]);
      // A table's column holds the key's value, which is what the group's id
      // holds of the source's link.
      await client.budget.createMany({
        data: [
          { id: 1, storeRef: 2 },
          { id: 2, storeRef: 3 },
        ],
      });
      expect(
        await client.budget.findMany({
          orderBy: { id: "asc" },
          select: { id: true, totals: { select: { sumUnits: true } } },
        })
      ).toEqual([
        { id: 1, totals: { sumUnits: 9 } },
        { id: 2, totals: null },
      ]);
      expect(
        await client.byStore.findMany({
          orderBy: { storeId: "asc" },
          select: { storeId: true, budgets: { select: { id: true } } },
        })
      ).toEqual([
        { storeId: 1, budgets: [] },
        { storeId: 2, budgets: [{ id: 1 }] },
      ]);
      expect(
        await client.budget.findMany({
          where: { totals: { sumUnits: { gt: 1 } } },
          select: { id: true },
        })
      ).toEqual([{ id: 1 }]);
      expect(
        await client.byStore.findMany({
          where: { budgets: { some: {} } },
          select: { storeId: true },
        })
      ).toEqual([{ storeId: 2 }]);
    });
  });

  it("a view over an aggregated view, an aggregated view over a view, and one over another", async () => {
    const busyQuery = {
      where: { count: { gt: 1 } },
      select: { storeId: true, currency: true, count: true, sumAmount: true },
    } as const;
    const busy = s.view(() => totals, busyQuery).map("sa_busy");
    const bigSalesQuery = {
      where: { units: { gte: 2 } },
      select: { id: true, storeId: true, units: true, amount: true },
    } as const;
    const bigSales = s.view(() => sale, bigSalesQuery).map("sa_big_sales");
    const bigByStoreQuery = {
      by: ["storeId"],
      _count: true,
      _sum: { units: true, amount: true },
    } as const;
    const bigByStore = s
      .view(() => bigSales, bigByStoreQuery)
      .map("sa_big_by_store");
    const byCurrencyQuery = {
      by: ["currency"],
      _sum: { count: true, sumAmount: true },
    } as const;
    const byCurrency = s
      .view(() => totals, byCurrencyQuery)
      .map("sa_by_currency");
    const driver = await freshDriver();
    const client = clientOf(
      { ...schema, busy, bigSales, bigByStore, byCurrency },
      driver
    );
    await using(client, async () => {
      await push(client);
      await seed(client);
      const nested = async () => {
        expect(unordered(await client.busy.findMany())).toEqual(
          unordered(await client.totals.findMany(busyQuery))
        );
        // Store 1's euro sales stay two through the writes below.
        expect(
          await client.busy.findUnique({
            where: { storeId_currency: { storeId: 1, currency: "EUR" } },
            select: { count: true },
          })
        ).toEqual({ count: 2 });
        const bigByStoreRows = unordered(await client.bigByStore.findMany());
        expect(bigByStoreRows).toEqual(
          unordered(
            (await client.bigSales.groupBy(grouping(bigByStoreQuery))).map(
              flattened
            )
          )
        );
        expect(bigByStoreRows).toEqual(
          unordered(
            (
              await client.sale.groupBy({
                ...grouping(bigByStoreQuery),
                where: bigSalesQuery.where,
              })
            ).map(flattened)
          )
        );
        expect(unordered(await client.byCurrency.findMany())).toEqual(
          unordered(
            (await client.totals.groupBy(grouping(byCurrencyQuery))).map(
              flattened
            )
          )
        );
      };
      await nested();
      await client.sale.update({ where: { id: "s3" }, data: { units: 8 } });
      await client.sale.delete({ where: { id: "s5" } });
      await nested();
      expect(
        await client.byCurrency.findUnique({
          where: { currency: "USD" },
          select: { sumCount: true },
        })
      ).toEqual({ sumCount: 2 });
    });
  });

  it("a grouped field named id, the source's key, and an int, read from the group's id", async () => {
    const thing = s
      .model({
        slug: s.string().id(),
        id: s.string(),
        label: s.string().map("thing_label"),
        n: s.int(),
      })
      .map("sa_things");
    const byOwnId = s
      .view(() => thing, { by: ["id"], _sum: { n: true } })
      .map("sa_by_own_id");
    const bySlug = s
      .view(() => thing, { by: ["slug", "label"], _count: true })
      .map("sa_by_slug");
    // An int column is stored as an i32, which a record id holds apart from
    // the int a lookup by value names.
    const byN = s.view(() => thing, { by: ["n"], _count: true }).map("sa_by_n");
    const driver = await freshDriver();
    const client = clientOf({ thing, byOwnId, bySlug, byN }, driver);
    await using(client, async () => {
      const { statements } = await push(client);
      expect(
        statements
          .filter((statement: string) => statement.includes(" AS SELECT "))
          .map((statement: string) =>
            statement.replace(MARKER, "viborm_view_…")
          )
          .sort()
      ).toEqual([
        'DEFINE TABLE sa_by_n AS SELECT <int> n AS n, count() AS count FROM sa_things GROUP BY n COMMENT "viborm_view_…";',
        'DEFINE TABLE sa_by_own_id AS SELECT id_field AS id, math::sum(n) AS sumN FROM sa_things GROUP BY id COMMENT "viborm_view_…";',
        'DEFINE TABLE sa_by_slug AS SELECT record::id(id) AS slug, thing_label AS label, count() AS count FROM sa_things GROUP BY slug, label COMMENT "viborm_view_…";',
      ]);
      await client.thing.createMany({
        data: [
          { slug: "a", id: "x", label: "one", n: 1 },
          { slug: "b", id: "x", label: "two", n: 2 },
          { slug: "c", id: "y", label: "two", n: 4 },
        ],
      });
      expect(await client.byOwnId.findMany({ orderBy: { id: "asc" } })).toEqual(
        [
          { id: "x", sumN: 3 },
          { id: "y", sumN: 4 },
        ]
      );
      expect(await client.byOwnId.findUnique({ where: { id: "y" } })).toEqual({
        id: "y",
        sumN: 4,
      });
      expect(
        await client.bySlug.findUnique({
          where: { slug_label: { slug: "b", label: "two" } },
        })
      ).toEqual({ slug: "b", label: "two", count: 1 });
      expect(
        await client.bySlug.findMany({
          where: { slug: { in: ["a", "c"] } },
          orderBy: { slug: "desc" },
        })
      ).toEqual([
        { slug: "c", label: "two", count: 1 },
        { slug: "a", label: "one", count: 1 },
      ]);
      expect(await client.byN.findUnique({ where: { n: 2 } })).toEqual({
        n: 2,
        count: 1,
      });
    });
  });

  it("a bigint sum past 2^63: the view holds it exactly and the write that carries it there is not refused, where groupBy cannot read it", async () => {
    const huge = s
      .model({ id: s.int().id(), part: s.string(), big: s.bigInt() })
      .map("sa_huge");
    const hugeTotals = s
      .view(() => huge, {
        by: ["part"],
        _sum: { big: true },
        _avg: { big: true },
      })
      .map("sa_huge_totals");
    const driver = await freshDriver();
    const client = clientOf({ huge, hugeTotals }, driver);
    await using(client, async () => {
      await push(client);
      for (const id of [1, 2])
        await client.huge.create({
          data: { id, part: "a", big: 9_000_000_000_000_000_000n },
        });
      expect(await client.hugeTotals.findMany()).toEqual([
        { part: "a", sumBig: 18_000_000_000_000_000_000n, avgBig: 9e18 },
      ]);
      await expect(
        client.huge.groupBy({ by: ["part"], _sum: { big: true } })
      ).rejects.toThrow();
      await client.huge.delete({ where: { id: 2 } });
      expect(
        (await client.huge.groupBy({ by: ["part"], _sum: { big: true } })).map(
          flattened
        )
      ).toEqual(
        await client.hugeTotals.findMany({
          select: { part: true, sumBig: true },
        })
      );
    });
  });

  it("a query SurrealDB cannot keep current as a view is refused with the view named, before any effect", async () => {
    const refused: readonly [Record<string, unknown>, RegExp][] = [
      [
        {
          by: ["storeId"],
          having: { units: { _sum: { gt: 1 } } },
          _count: true,
        },
        HAVING,
      ],
      [
        { by: ["storeId"], _count: true, orderBy: { storeId: "asc" }, take: 1 },
        WINDOW,
      ],
      [
        { by: ["storeId"], _count: true, orderBy: { storeId: "asc" }, skip: 1 },
        SKIPS,
      ],
      [{ by: ["storeId"], _count: true, orderBy: { storeId: "asc" } }, ORDER],
      [
        { by: [{ soldAt: "day" }], timeZone: "Europe/Paris", _count: true },
        STEP,
      ],
      [{ by: ["storeId"], _sum: { ratio: true } }, DOUBLE_SUM],
      [{ by: ["storeId"], _avg: { ratio: true } }, DOUBLE_AVG],
      [{ by: ["storeId"], _min: { label: true } }, STRING_MIN],
      [{ by: ["storeId"], _max: { currency: true } }, ENUM_MAX],
      [{ by: ["currency"], _min: { id: true } }, KEY_MIN],
      [{ by: ["currency"], _sum: { storeId: true } }, LINK_SUM],
      [
        { by: ["currency"], where: { store: { name: "North" } }, _count: true },
        RELATION_FILTER,
      ],
    ];
    for (const [query, message] of refused) {
      const bad = s.view((): AnyModel => sale, query as never).map("sa_bad");
      const driver = await freshDriver();
      const client = clientOf({ store, sale, budget, byStore, bad }, driver);
      await using(client, async () => {
        const failure = createMigrationClient(client).push({ dryRun: true });
        await expect(failure).rejects.toThrow(UnsupportedOperationError);
        await expect(failure).rejects.toThrow(message);
      });
    }
  });

  it("a changed query replaces the view, materialized changes nothing, and a force-reset push removes it before its source", async () => {
    const driver = await freshDriver();
    const client = clientOf(schema, driver);
    await using(client, async () => {
      await push(client);
      await seed(client);
      const changedQuery = { ...byRegionQuery, _sum: { units: true } };
      const changed = clientOf(
        {
          ...schema,
          byRegion: s.view(() => sale, changedQuery).map("sa_by_region"),
        },
        driver
      );
      expect((await push(changed)).labels).toEqual([
        '- Drop view "sa_by_region"',
        '+ Create view "sa_by_region"',
      ]);
      expect(unordered(await changed.byRegion.findMany())).toEqual(
        unordered(
          (
            await changed.sale.groupBy(
              grouping({ ...changedQuery, by: ["region"] })
            )
          ).map(flattened)
        )
      );
      const materialized = clientOf(
        {
          ...schema,
          byRegion: s
            .view(() => sale, changedQuery)
            .materialized()
            .map("sa_by_region"),
        },
        driver
      );
      expect(await createMigrationClient(materialized).push()).toMatchObject({
        outcome: "noop",
      });
      await expect(materialized.byRegion.$refresh()).resolves.toBeUndefined();
      const plan = await createMigrationClient(changed).push({
        dryRun: true,
        forceReset: true,
      });
      const at = (table: string) =>
        plan.statements.findIndex(
          ({ sql }: { sql: string }) =>
            sql.startsWith(`REMOVE TABLE ${table};`) ||
            sql.startsWith(`REMOVE TABLE IF EXISTS ${table};`)
        );
      expect(at("sa_totals")).toBeGreaterThanOrEqual(0);
      expect(at("sa_totals")).toBeLessThan(at("sa_sales"));
      expect(at("sa_by_region")).toBeLessThan(at("sa_sales"));
      await createMigrationClient(changed).push({ consent: plan.consent });
      expect(await changed.totals.count()).toBe(0);
      expect(await createMigrationClient(changed).push()).toMatchObject({
        outcome: "noop",
      });
      await changed.$disconnect();
      await materialized.$disconnect();
    });
  });
});
