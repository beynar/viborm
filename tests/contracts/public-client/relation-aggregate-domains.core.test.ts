/**
 * `_aggregate` and an order by an aggregate read a relation's rows as every
 * other relation read does: a row the caller cannot see (a permission's
 * `read`, a soft-deleted row) is not aggregated, and a read-gated field reads
 * NULL on a row that withholds it, so `_sum` and `_count` of it skip that row,
 * as `aggregate` does (docs/content/docs/extensions/permissions.mdx, "Protecting
 * fields"). On SQLite3, in memory.
 */

import { createClient } from "@client/client";
import { s } from "@schema";
import { permissions } from "@src/permissions";
import { softDelete } from "@src/soft-delete";
import { v } from "@src/validation";
import { createInMemorySQLite3Driver } from "@tests/fixtures/drivers/sqlite3";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const shop = s.model({
  id: s.string().id(),
  orders: s.toMany(() => order),
});
const order = s.model({
  id: s.string().id(),
  shopId: s.string(),
  shop: s
    .toOne(() => shop)
    .fields("shopId")
    .references("id"),
  total: s.int(),
  cost: s.int(),
  published: s.boolean(),
  deletedAt: s.dateTime().nullable(),
});
const schema = { shop, order };

const clients: { $disconnect(): Promise<void> }[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.$disconnect();
});

/** s1: o1 (published, 5, cost 1) and o2 (draft, 100, cost 50); s2: o3 (published, 7, cost 2). */
async function seeded() {
  const base = createClient({ schema, driver: createInMemorySQLite3Driver() });
  clients.push(base);
  await syncLiveSchema(base);
  await base.shop.createMany({ data: [{ id: "s1" }, { id: "s2" }] });
  await base.order.createMany({
    data: [
      { id: "o1", shopId: "s1", total: 5, cost: 1, published: true },
      { id: "o2", shopId: "s1", total: 100, cost: 50, published: false },
      { id: "o3", shopId: "s2", total: 7, cost: 2, published: true },
    ],
  });
  return base;
}

const AGGREGATED = {
  orderBy: [
    { orders: { _sum: { total: { sort: "desc", nulls: "last" } } } },
    { id: "asc" },
  ],
  select: {
    id: true,
    _aggregate: {
      orders: {
        _count: { _all: true, cost: true },
        _sum: { total: true, cost: true },
      },
    },
  },
} as const;

describe("_aggregate reads the rows the caller reads", () => {
  test("a soft-deleted row is neither aggregated nor ordered by", async () => {
    const db = (await seeded()).$extends(
      softDelete({ models: { order: { deletedAt: "deletedAt" } } })
    );
    await db.order.delete({ where: { id: "o2" } });
    expect(await db.shop.findMany(AGGREGATED)).toEqual([
      {
        id: "s2",
        _aggregate: {
          orders: { _count: { _all: 1, cost: 1 }, _sum: { total: 7, cost: 2 } },
        },
      },
      {
        id: "s1",
        _aggregate: {
          orders: { _count: { _all: 1, cost: 1 }, _sum: { total: 5, cost: 1 } },
        },
      },
    ]);
  });

  test("a permission's read hides rows, and a read-gated field reads NULL", async () => {
    const db = (await seeded()).$extends(
      permissions({
        actor: v.object({ admin: v.boolean() }),
        models: {
          shop: { read: true },
          order: {
            actions: { read: [], full: ["read"], create: [] },
            operations: { read: "read", update: "full", delete: "full" },
            read: { published: true },
            full: { actor: { admin: true } },
            create: false,
            fields: { cost: { read: "full" } },
          },
        },
      })
    );
    // The reader sees the published orders, and no cost on any of them.
    expect(await db.$as({ admin: false }).shop.findMany(AGGREGATED)).toEqual([
      {
        id: "s2",
        _aggregate: {
          orders: {
            _count: { _all: 1, cost: 0 },
            _sum: { total: 7, cost: null },
          },
        },
      },
      {
        id: "s1",
        _aggregate: {
          orders: {
            _count: { _all: 1, cost: 0 },
            _sum: { total: 5, cost: null },
          },
        },
      },
    ]);
    // The admin sees every order and every cost.
    expect(await db.$as({ admin: true }).shop.findMany(AGGREGATED)).toEqual([
      {
        id: "s1",
        _aggregate: {
          orders: {
            _count: { _all: 2, cost: 2 },
            _sum: { total: 105, cost: 51 },
          },
        },
      },
      {
        id: "s2",
        _aggregate: {
          orders: { _count: { _all: 1, cost: 1 }, _sum: { total: 7, cost: 2 } },
        },
      },
    ]);
    // An order by a gated field's aggregate reads it as the reader does: NULL.
    const byCost = await db.$as({ admin: false }).shop.findMany({
      orderBy: [{ orders: { _max: { cost: "asc" } } }, { id: "desc" }],
      select: { id: true },
    });
    expect(byCost).toEqual([{ id: "s2" }, { id: "s1" }]);
  });
});

// A many-to-many relation reaches its rows through the junction: the entry's
// one subquery and the order's read the target rows the junction links.
const label = s.model({
  id: s.string().id(),
  items: s.toMany(() => item),
});
const item = s.model({
  id: s.string().id(),
  price: s.int(),
  labels: s.toMany(() => label),
});

test("a many-to-many relation is aggregated and ordered through its junction", async () => {
  const db = createClient({
    schema: { label, item },
    driver: createInMemorySQLite3Driver(),
  });
  clients.push(db);
  await syncLiveSchema(db);
  await db.item.createMany({
    data: [
      { id: "i1", price: 3 },
      { id: "i2", price: 4 },
      { id: "i3", price: 10 },
    ],
  });
  await db.label.create({
    data: { id: "a", items: { connect: [{ id: "i1" }, { id: "i2" }] } },
  });
  await db.label.create({
    data: { id: "b", items: { connect: [{ id: "i2" }, { id: "i3" }] } },
  });
  await db.label.create({ data: { id: "c" } });
  expect(
    await db.label.findMany({
      orderBy: { items: { _sum: { price: { sort: "desc", nulls: "last" } } } },
      select: {
        id: true,
        _aggregate: { items: { _count: true, _sum: { price: true } } },
      },
    })
  ).toEqual([
    { id: "b", _aggregate: { items: { _count: 2, _sum: { price: 14 } } } },
    { id: "a", _aggregate: { items: { _count: 2, _sum: { price: 7 } } } },
    { id: "c", _aggregate: { items: { _count: 0, _sum: { price: null } } } },
  ]);
});
