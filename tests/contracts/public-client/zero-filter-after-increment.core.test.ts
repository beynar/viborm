/**
 * A zero filter operand never inherits an auto-increment's create rule
 * (engine-02, 1.0.0): the int/bigint filter is interned per kind, and with an
 * increment id built first its create-time zero refusal reached every
 * `where: { qty: 0 }`, root and nested. Intern caches live for the module
 * graph, so each declaration order runs on a fresh graph.
 */

import { expect, onTestFinished, test, vi } from "vitest";

const ZERO_REFUSAL = /Explicit zero is not portable/;

test.each([
  true,
  false,
])("zero filters match rows (increment first: %s)", async (incrementFirst) => {
  vi.resetModules();
  const { s } = await import("@schema");
  const { createClient } = await import("@drivers/sqlite3");
  const { syncLiveSchema } = await import("@tests/fixtures/sync-schema");
  const stamps = () => ({
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  });
  const basket = s.model({
    id: s.int().id().increment(),
    ...stamps(),
    lines: s.toMany(() => line),
  });
  const counters = {
    qty: s.int(),
    units: s.bigInt(),
    note: s.string().nullable(),
  };
  const keys = {
    id: s.bigInt().id().increment(),
    basketId: s.int(),
    basket: s
      .toOne(() => basket)
      .fields("basketId")
      .references("id"),
    ...stamps(),
  };
  const line = s.model(
    incrementFirst ? { ...keys, ...counters } : { ...counters, ...keys }
  );
  const db = createClient({ schema: { basket, line }, dataDir: ":memory:" });
  onTestFinished(() => db.$disconnect());
  await syncLiveSchema(db);
  // A where tree builds its fields' filters in declaration order.
  if (incrementFirst) await db.basket.count({ where: {} });
  else await db.line.count({ where: {} });

  await expect(db.basket.create({ data: { id: 0 } })).rejects.toThrow(
    ZERO_REFUSAL
  );
  await db.basket.createMany({ data: [{}, {}] });
  // qty 0,1,2,0,1,2 and units 0,1,0,1,0,1; three lines per basket.
  const data = [0, 1, 2, 3, 4, 5].map((i) => ({
    qty: i % 3,
    units: BigInt(i % 2),
    basketId: i < 3 ? 1 : 2,
  }));
  await db.line.createMany({ data });
  const reads = [
    [{ qty: 0 }, 2],
    [{ qty: { equals: 0 } }, 2],
    [{ qty: { not: 0 } }, 4],
    [{ units: 0n }, 3],
    [{ units: { not: 0n } }, 3],
    [{ id: 0n }, 0],
  ] as const;
  for (const [where, rows] of reads) {
    expect(await db.line.count({ where })).toBe(rows);
  }
  expect(await db.basket.findMany({ where: { id: 0 } })).toEqual([]);

  expect(
    await db.line.updateMany({ where: { units: 0n }, data: { note: "empty" } })
  ).toEqual({ count: 3 });
  await db.basket.update({
    where: { id: 1 },
    data: { lines: { updateMany: { where: { qty: 0 }, data: { qty: 9 } } } },
  });
  expect(await db.line.count({ where: { qty: 9 } })).toBe(1);
  await db.basket.update({
    where: { id: 1 },
    data: { lines: { deleteMany: { units: { equals: 0n } } } },
  });
  expect(await db.line.deleteMany({ where: { qty: 0 } })).toEqual({ count: 1 });
  expect(await db.line.count()).toBe(3);
});
