// biome-ignore-all lint/suspicious/noMisplacedAssertion: `expectCurrent` and `exerciseAutoViews` are invoked only from registered tests.
/**
 * Views kept by triggers (`.materialized({ refresh: "auto" })`) against a
 * real database: a push creates the table that holds a view's rows, the
 * triggers that keep it and its rows; each write to the source moves it at
 * once (insert, update of a group, of the filter or of the key, delete, the
 * many forms, a rolled-back transaction), a cascade from a parent or a
 * grandparent moves it too (MySQL by its parents' triggers), `$refresh`
 * computes it whole again after a write its triggers did not see, a second
 * push plans nothing, a trigger dropped by hand is drift the next push
 * repairs, a change to its source replaces it, and the history converges.
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers";
import { CONTROL_TABLES } from "@migrations/control";
import {
  createMigrationClient,
  MemoryEstateStorage,
} from "@migrations/dialects/all";
import { PG, s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { describe, expect, onTestFinished, test } from "vitest";

const byShopQuery = {
  where: { status: "paid" },
  by: ["shopId"],
  _count: true,
  _sum: { amount: true },
  _max: { amount: true },
} as const;
const paidQuery = {
  where: { status: "paid" },
  select: { id: true, shopId: true, customerId: true, amount: true },
} as const;

/**
 * One version of the schema, its models made anew (a model binds one schema
 * for good): the tables, the views or not, and a source with one more column
 * or not (a change its views do not survive).
 */
function schema<const Views extends boolean>(views: Views, note = false) {
  const region = s
    .model({
      id: s.string().id(),
      shops: s.toMany(() => shop),
    })
    .map("av_regions");
  const shop = s
    .model({
      id: s.string().id(),
      regionId: s.string(),
      region: s
        .toOne(() => region)
        .fields("regionId")
        .references("id")
        .onDelete("cascade"),
      sales: s.toMany(() => sale),
    })
    .map("av_shops");
  const customer = s
    .model({
      id: s.string().id(),
      sales: s.toMany(() => sale),
    })
    .map("av_customers");
  const fields = {
    id: s.string().id(),
    // Stored under another name: a trigger reads it as the source names it.
    shopId: s.string().map("shop_id"),
    customerId: s.string().nullable(),
    status: s.string(),
    amount: s.int().nullable(),
    shop: s
      .toOne(() => shop)
      .fields("shopId")
      .references("id")
      .onDelete("cascade"),
    customer: s
      .toOne(() => customer)
      .fields("customerId")
      .references("id")
      .onDelete("setNull"),
  };
  // Typed as the source without the column: the views' queries are its.
  const sale = (
    note
      ? (s.model({
          ...fields,
          note: s.string().nullable(),
        }) as unknown as ReturnType<typeof s.model<typeof fields>>)
      : s.model(fields)
  ).map("av_sales");
  const byShop = s
    .view(() => sale, byShopQuery)
    .materialized({ refresh: "auto" })
    .map("av_by_shop");
  const paid = s
    .view(() => sale, paidQuery)
    .materialized({ refresh: "auto" })
    .map("av_paid");
  return (
    views
      ? { region, shop, customer, sale, byShop, paid }
      : { region, shop, customer, sale }
  ) as Views extends true
    ? {
        region: typeof region;
        shop: typeof shop;
        customer: typeof customer;
        sale: typeof sale;
        byShop: typeof byShop;
        paid: typeof paid;
      }
    : {
        region: typeof region;
        shop: typeof shop;
        customer: typeof customer;
        sale: typeof sale;
      };
}

/**
 * The views' schema, for a test that creates it its own way (D1 refuses a
 * live push; a Durable Object runs each test in an object of its own).
 */
export const autoViewsSchema = () => schema(true);

/**
 * Writes on a database whose tables and views are created and empty, each
 * checked against the views' query read on the source: rows in, a group,
 * the filter and the key moved, the many forms, a group that empties, a
 * cascade from a grandparent and a setNull, then `$refresh` after a write
 * its triggers did not see.
 */
export async function exerciseAutoViews(
  client: Client,
  quote: (name: string) => string
): Promise<void> {
  const groups = () => client.byShop.findMany({ orderBy: { shopId: "asc" } });
  const current = async () => {
    const truth = await client.sale.groupBy({
      by: ["shopId"],
      where: { status: "paid" },
      _count: true,
      _sum: { amount: true },
      _max: { amount: true },
      orderBy: { shopId: "asc" },
    });
    expect(await groups()).toEqual(
      truth.map((group) => ({
        shopId: group.shopId,
        count: group._count,
        sumAmount: group._sum.amount,
        maxAmount: group._max.amount,
      }))
    );
    expect(await client.paid.findMany({ orderBy: { id: "asc" } })).toEqual(
      await client.sale.findMany({ ...paidQuery, orderBy: { id: "asc" } })
    );
  };
  await client.region.createMany({ data: [{ id: "north" }, { id: "south" }] });
  await client.shop.createMany({
    data: [
      { id: "a", regionId: "north" },
      { id: "b", regionId: "south" },
    ],
  });
  await client.customer.createMany({ data: [{ id: "c1" }, { id: "c2" }] });
  await client.sale.createMany({
    data: [
      { id: "1", shopId: "a", customerId: "c1", status: "paid", amount: 5 },
      { id: "2", shopId: "b", customerId: "c2", status: "paid", amount: 3 },
      { id: "3", shopId: "b", customerId: null, status: "paid", amount: 10 },
      { id: "4", shopId: "b", customerId: "c1", status: "open", amount: 7 },
    ],
  });
  await current();
  expect(await groups()).toEqual([
    { shopId: "a", count: 1, sumAmount: 5, maxAmount: 5 },
    { shopId: "b", count: 2, sumAmount: 13, maxAmount: 10 },
  ]);
  await client.sale.create({
    data: { id: "5", shopId: "a", status: "paid", amount: null },
  });
  await client.sale.update({ where: { id: "4" }, data: { status: "paid" } });
  await client.sale.update({ where: { id: "2" }, data: { shopId: "a" } });
  await client.sale.update({ where: { id: "1" }, data: { id: "1b" } });
  await client.sale.updateMany({
    where: { id: "3" },
    data: { amount: 12 },
  });
  await current();
  await client.customer.delete({ where: { id: "c2" } });
  await current();
  await client.region.delete({ where: { id: "south" } });
  await current();
  expect(await groups()).toEqual([
    { shopId: "a", count: 3, sumAmount: 8, maxAmount: 5 },
  ]);
  await client.$executeRawUnsafe(`DELETE FROM ${quote("av_by_shop")}`);
  expect(await groups()).toEqual([]);
  await client.byShop.$refresh();
  await current();
}

export interface AutoViewsProvider {
  readonly name: string;
  readonly dialect: "postgresql" | "mysql" | "sqlite";
  readonly createDriver: () => AnyDriver | Promise<AnyDriver>;
  /** The driver runs a callback transaction (D1 does not). */
  readonly transactions?: boolean;
  /** The database takes two writers at once (PostgreSQL, MySQL). */
  readonly concurrent?: boolean;
  /** The database has roles a test may create (PostgreSQL's server). */
  readonly roles?: boolean;
}

type Client = ReturnType<typeof viewsClient>;
const viewsClient = (driver: AnyDriver) =>
  createClient({ driver, schema: schema(true) });

export function runAutoViewsBehavior(provider: AutoViewsProvider): void {
  const { dialect } = provider;
  // One database for the file: PGlite holds one in memory per driver.
  let shared: Promise<AnyDriver> | undefined;
  const database = () => {
    shared ??= Promise.resolve(provider.createDriver());
    return shared;
  };
  /**
   * A database emptied of what a test before left: its history (whose marker
   * a push refuses), then every table and view. The suites after this file
   * may share the database.
   */
  async function cleared(driver: AnyDriver): Promise<void> {
    const client = createClient({ driver, schema: {} });
    for (const table of [CONTROL_TABLES.log, CONTROL_TABLES.state])
      await client.$executeRawUnsafe(
        `DROP TABLE IF EXISTS ${dialect === "mysql" ? `\`${table}\`` : `"${table}"`}`
      );
    await syncLiveSchema(client as never, { force: true });
  }
  /** A database with the tables, no view, and a few rows. */
  async function seeded(): Promise<AnyDriver> {
    const driver = await database();
    const client = createClient({ driver, schema: schema(false) });
    // A database a run before left views, rows and a history in.
    for (const table of [CONTROL_TABLES.log, CONTROL_TABLES.state])
      await client.$executeRawUnsafe(
        `DROP TABLE IF EXISTS ${dialect === "mysql" ? `\`${table}\`` : `"${table}"`}`
      );
    await syncLiveSchema(client as never, { force: true });
    await client.sale.deleteMany();
    await client.shop.deleteMany();
    await client.region.deleteMany();
    await client.customer.deleteMany();
    await client.region.createMany({
      data: [{ id: "north" }, { id: "south" }],
    });
    await client.shop.createMany({
      data: [
        { id: "a", regionId: "north" },
        { id: "b", regionId: "south" },
      ],
    });
    await client.customer.createMany({ data: [{ id: "c1" }, { id: "c2" }] });
    await client.sale.createMany({
      data: [
        { id: "1", shopId: "a", customerId: "c1", status: "paid", amount: 5 },
        { id: "2", shopId: "b", customerId: "c2", status: "paid", amount: 3 },
        { id: "3", shopId: "b", customerId: null, status: "paid", amount: 10 },
        { id: "4", shopId: "b", customerId: "c1", status: "open", amount: 7 },
      ],
    });
    return driver;
  }
  const groups = (client: Client) =>
    client.byShop.findMany({ orderBy: { shopId: "asc" } });
  const rows = (client: Client) =>
    client.paid.findMany({ orderBy: { id: "asc" } });
  /** What the views must hold: their query, read on the source now. */
  async function expectCurrent(client: Client): Promise<void> {
    const truth = await client.sale.groupBy({
      by: ["shopId"],
      where: { status: "paid" },
      _count: true,
      _sum: { amount: true },
      _max: { amount: true },
      orderBy: { shopId: "asc" },
    });
    expect(await groups(client)).toEqual(
      truth.map((group) => ({
        shopId: group.shopId,
        count: group._count,
        sumAmount: group._sum.amount,
        maxAmount: group._max.amount,
      }))
    );
    expect(await rows(client)).toEqual(
      await client.sale.findMany({
        ...paidQuery,
        orderBy: { id: "asc" },
      })
    );
  }
  const dropTrigger = (name: string, table: string) =>
    dialect === "postgresql"
      ? `DROP TRIGGER "${name}" ON "${table}"`
      : dialect === "mysql"
        ? `DROP TRIGGER \`${name}\``
        : `DROP TRIGGER "${name}"`;

  describe(`${provider.name}: views kept by triggers`, () => {
    test("a push creates them with their rows, and each write moves them", async () => {
      const driver = await seeded();
      const client = viewsClient(driver);
      const created = await syncLiveSchema(client as never);
      expect(created.applied).toBe(true);
      expect(await groups(client)).toEqual([
        { shopId: "a", count: 1, sumAmount: 5, maxAmount: 5 },
        { shopId: "b", count: 2, sumAmount: 13, maxAmount: 10 },
      ]);
      await expectCurrent(client);

      // A row in, a NULL to sum, the filter, the group and the key moved.
      await client.sale.create({
        data: { id: "5", shopId: "a", status: "paid", amount: null },
      });
      await client.sale.update({
        where: { id: "4" },
        data: { status: "paid" },
      });
      await client.sale.update({ where: { id: "2" }, data: { shopId: "a" } });
      await client.sale.update({ where: { id: "1" }, data: { id: "1b" } });
      await expectCurrent(client);
      expect(await groups(client)).toEqual([
        { shopId: "a", count: 3, sumAmount: 8, maxAmount: 5 },
        { shopId: "b", count: 2, sumAmount: 17, maxAmount: 10 },
      ]);

      // The many forms, a group that empties and one that comes back.
      await client.sale.updateMany({
        where: { shopId: "b" },
        data: { status: "open" },
      });
      expect(await groups(client)).toEqual([
        { shopId: "a", count: 3, sumAmount: 8, maxAmount: 5 },
      ]);
      await client.sale.createMany({
        data: [
          { id: "6", shopId: "b", status: "paid", amount: 1 },
          { id: "7", shopId: "b", status: "paid", amount: null },
        ],
      });
      await client.sale.deleteMany({ where: { shopId: "a" } });
      await expectCurrent(client);
      expect(await groups(client)).toEqual([
        { shopId: "b", count: 2, sumAmount: 1, maxAmount: 1 },
      ]);
      // A group of NULL amounts only: no sum, no greatest.
      await client.sale.update({ where: { id: "6" }, data: { amount: null } });
      expect(await groups(client)).toEqual([
        { shopId: "b", count: 2, sumAmount: null, maxAmount: null },
      ]);

      if (provider.transactions !== false) {
        await expect(
          client.$transaction(async (tx) => {
            await tx.sale.create({
              data: { id: "8", shopId: "b", status: "paid", amount: 50 },
            });
            await tx.sale.deleteMany({ where: { id: "7" } });
            throw new Error("rolled back");
          })
        ).rejects.toThrow("rolled back");
        expect(await groups(client)).toEqual([
          { shopId: "b", count: 2, sumAmount: null, maxAmount: null },
        ]);
      }
      await expectCurrent(client);
    });

    test.runIf(dialect === "postgresql")(
      "a native json column is kept: an update compares what the view reads as text",
      async () => {
        const driver = await database();
        await cleared(driver);
        const event = s
          .model({
            id: s.string().id(),
            kind: s.string(),
            payload: s.json(PG.JSON.JSON),
          })
          .map("av_events");
        const kept = s
          .view(() => event, { select: { id: true, payload: true } })
          .materialized({ refresh: "auto" })
          .map("av_kept_events");
        const client = createClient({ driver, schema: { event, kept } });
        await syncLiveSchema(client as never);
        await client.event.create({
          data: { id: "e1", kind: "a", payload: { n: 1 } },
        });
        await client.event.update({
          where: { id: "e1" },
          data: { payload: { n: 2 } },
        });
        await client.event.update({ where: { id: "e1" }, data: { kind: "b" } });
        expect(await client.kept.findMany()).toEqual([
          { id: "e1", payload: { n: 2 } },
        ]);
        await cleared(driver);
      }
    );

    test.runIf(provider.roles)(
      "a role that writes the source and reads the view needs no right on the view's table",
      async () => {
        const driver = await seeded();
        const client = viewsClient(driver);
        await syncLiveSchema(client as never);
        const role = "av_writer";
        await client.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`);
        await client.$executeRawUnsafe(`CREATE ROLE ${role}`);
        await client.$executeRawUnsafe(
          `GRANT USAGE ON SCHEMA public TO ${role}`
        );
        await client.$executeRawUnsafe(
          `GRANT SELECT, INSERT ON "av_sales" TO ${role}`
        );
        await client.$executeRawUnsafe(
          `GRANT SELECT ON "av_shops", "av_customers" TO ${role}`
        );
        try {
          await client.$transaction(async (tx) => {
            await tx.$executeRawUnsafe(`SET LOCAL ROLE ${role}`);
            await tx.$executeRawUnsafe(
              `INSERT INTO "av_sales" ("id", "shop_id", "status", "amount") VALUES ('r1', 'a', 'paid', 7)`
            );
          });
          await expectCurrent(client);
          expect(await groups(client)).toContainEqual({
            shopId: "a",
            count: 2,
            sumAmount: 12,
            maxAmount: 7,
          });
        } finally {
          await client.$executeRawUnsafe(`DROP OWNED BY ${role}`);
          await client.$executeRawUnsafe(`DROP ROLE ${role}`);
        }
      }
    );

    test.runIf(provider.concurrent)(
      "two writers to one group at once both land, at each isolation level",
      async () => {
        const driver = await seeded();
        const client = viewsClient(driver);
        await syncLiveSchema(client as never);
        const pause = (ms: number) =>
          new Promise((done) => setTimeout(done, ms));
        // The first writer holds its group's row until it commits; the
        // second writes the same group meanwhile, on its own connection.
        // Without the lock of the group, the second's insert of the row
        // the first wrote is refused (PostgreSQL, measured).
        const race = async (
          level: "ReadCommitted" | "RepeatableRead",
          ids: [string, string]
        ) => {
          const outcomes = await Promise.allSettled([
            client.$transaction(
              async (tx) => {
                await tx.sale.create({
                  data: { id: ids[0], shopId: "a", status: "paid", amount: 1 },
                });
                await pause(300);
              },
              { isolationLevel: level }
            ),
            (async () => {
              await pause(100);
              await client.$transaction(
                (tx) =>
                  tx.sale.create({
                    data: {
                      id: ids[1],
                      shopId: "a",
                      status: "paid",
                      amount: 2,
                    },
                  }),
                { isolationLevel: level }
              );
            })(),
          ]);
          return outcomes.map(({ status }) => status);
        };
        expect(await race("ReadCommitted", ["r1", "r2"])).toEqual([
          "fulfilled",
          "fulfilled",
        ]);
        await expectCurrent(client);
        // Under REPEATABLE READ a write that crosses another may fail, to
        // be retried, and no view row is ever stale.
        const repeatable = await race("RepeatableRead", ["r3", "r4"]);
        expect(repeatable[0]).toBe("fulfilled");
        await expectCurrent(client);
        if (repeatable[1] === "rejected") {
          await client.sale.create({
            data: { id: "r4", shopId: "a", status: "paid", amount: 2 },
          });
          await expectCurrent(client);
        }
      }
    );

    test("a cascade from a parent or a grandparent moves them, and so does a setNull", async () => {
      const driver = await seeded();
      const client = viewsClient(driver);
      await syncLiveSchema(client as never);
      await client.customer.delete({ where: { id: "c2" } });
      await expectCurrent(client);
      expect((await rows(client)).map((row) => row.customerId)).toEqual([
        "c1",
        null,
        null,
      ]);
      // Two levels: the region's shops go, and their sales with them.
      await client.region.delete({ where: { id: "south" } });
      await expectCurrent(client);
      expect(await groups(client)).toEqual([
        { shopId: "a", count: 1, sumAmount: 5, maxAmount: 5 },
      ]);
      await client.shop.delete({ where: { id: "a" } });
      expect(await groups(client)).toEqual([]);
      expect(await rows(client)).toEqual([]);
    });

    test("$refresh computes them whole again after a write their triggers did not see", async () => {
      const driver = await seeded();
      const client = viewsClient(driver);
      await syncLiveSchema(client as never);
      await client.$executeRawUnsafe(
        dialect === "mysql"
          ? "DELETE FROM `av_by_shop`"
          : 'DELETE FROM "av_by_shop"'
      );
      await client.$executeRawUnsafe(
        dialect === "mysql"
          ? "UPDATE `av_paid` SET `amount` = 99"
          : 'UPDATE "av_paid" SET "amount" = 99'
      );
      expect(await groups(client)).toEqual([]);
      await client.byShop.$refresh();
      await client.paid.$refresh();
      await expectCurrent(client);
    });

    test("a second push plans nothing; a trigger dropped by hand is drift the next push repairs", async () => {
      const driver = await seeded();
      const client = viewsClient(driver);
      await syncLiveSchema(client as never);
      expect((await syncLiveSchema(client as never)).operations).toEqual([]);
      await client.$executeRawUnsafe(
        dropTrigger("av_by_shop_viborm_i", "av_sales")
      );
      const repaired = await syncLiveSchema(client as never);
      expect(repaired.operations.map(({ type }) => type)).toEqual([
        "dropView",
        "createView",
      ]);
      await client.sale.create({
        data: { id: "9", shopId: "a", status: "paid", amount: 4 },
      });
      await expectCurrent(client);
      expect((await syncLiveSchema(client as never)).operations).toEqual([]);
      // Its table dropped by hand: its triggers are left, and the next push
      // creates it again over them.
      await client.$executeRawUnsafe(
        dialect === "mysql" ? "DROP TABLE `av_paid`" : 'DROP TABLE "av_paid"'
      );
      // Its body's view, left too, reads as an ordinary view it drops.
      const created = await syncLiveSchema(client as never);
      expect(created.operations.map(({ type }) => type)).toContain(
        "createView"
      );
      await client.sale.create({
        data: { id: "10", shopId: "b", status: "paid", amount: 6 },
      });
      await expectCurrent(client);
    });

    test("a change to their source replaces them, rows computed again", async () => {
      const driver = await seeded();
      const client = viewsClient(driver);
      await syncLiveSchema(client as never);
      const changed = createClient({ driver, schema: schema(true, true) });
      const push = await syncLiveSchema(changed as never);
      const types = push.operations.map(({ type }) => type);
      expect(types.filter((type) => type === "dropView")).toHaveLength(2);
      expect(types.filter((type) => type === "createView")).toHaveLength(2);
      await (changed.sale.create as (args: object) => Promise<unknown>)({
        data: { id: "9", shopId: "a", status: "paid", amount: 4, note: "n" },
      });
      await expectCurrent(changed as unknown as Client);
    });

    test("generate, apply, verify, down and reset converge", async () => {
      const driver = await database();
      await cleared(driver);
      // Its history stays behind it otherwise, which a later push refuses.
      onTestFinished(() => cleared(driver));
      const storage = new MemoryEstateStorage();
      const step = async (name: string, views: boolean) => {
        const migrations = createMigrationClient(
          createClient({ driver, schema: schema(views) }) as never,
          { storage }
        );
        await migrations.generate({ name });
        await expect(migrations.apply()).resolves.toMatchObject({
          outcome: "applied",
        });
        await expect(migrations.verify()).resolves.toEqual({ ok: true });
        return migrations;
      };
      const client = viewsClient(driver);
      await step("tables", false);
      await client.region.create({ data: { id: "north" } });
      await client.shop.create({ data: { id: "a", regionId: "north" } });
      await client.sale.create({
        data: { id: "1", shopId: "a", status: "paid", amount: 3 },
      });
      const migrations = await step("views", true);
      await expectCurrent(client);
      await client.sale.create({
        data: { id: "9", shopId: "a", status: "paid", amount: 4 },
      });
      await expectCurrent(client);

      await expect(migrations.down({ steps: 1 })).resolves.toMatchObject({
        preview: false,
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      // Without its triggers, a write to the source moves nothing.
      await client.sale.create({
        data: { id: "10", shopId: "a", status: "paid", amount: 1 },
      });

      // MySQL refuses a stepwise reset of tables that hold foreign keys.
      if (dialect === "mysql") return;
      await expect(migrations.reset()).resolves.toMatchObject({
        preview: false,
      });
      await expect(migrations.verify()).resolves.toEqual({ ok: true });
      await client.region.create({ data: { id: "east" } });
      await client.shop.create({ data: { id: "e", regionId: "east" } });
      await client.sale.create({
        data: { id: "11", shopId: "e", status: "paid", amount: 2 },
      });
      await expectCurrent(client);
      expect(await groups(client)).toEqual([
        { shopId: "e", count: 1, sumAmount: 2, maxAmount: 2 },
      ]);
    });
  });
}
