/**
 * A zero filter operand never inherits an auto-increment's create rule
 * (engine-02, 1.0.0).
 *
 * `.increment()` refuses an explicit `0` on create: databases disagree about
 * what inserting zero into an auto-increment column means. In 1.0.0 that
 * refusal leaked into the filter operand, which the scalar family interns per
 * kind under a key that spells only nullable/array. Whichever field built the
 * shared int (or bigint) filter FIRST decided it for the whole process: with
 * an increment id built first, `where: { qty: 0 }` on every plain int column,
 * root or nested, threw "Explicit zero is not portable".
 *
 * Intern caches live for the module graph, so each declaration order runs on
 * a fresh graph: what is measured is the order, not the test's position.
 */

import { afterEach, describe, expect, test, vi } from "vitest";

const ZERO_REFUSAL = /Explicit zero is not portable/;
const LINES = 300;
const BASKETS = 3;

const rows = Array.from({ length: LINES }, (_, i) => ({
  sku: `sku-${i}`,
  qty: i % 5,
  units: BigInt(i % 4),
  basketId: (i % BASKETS) + 1,
}));
const where = (keep: (row: (typeof rows)[number]) => boolean) =>
  rows.filter(keep).length;

/** A fresh module graph, then the two models in the requested order. */
const openStore = async (incrementFirst: boolean) => {
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
    ref: s.string(),
    ...stamps(),
    lines: s.toMany(() => line),
  });
  const counters = {
    qty: s.int(),
    units: s.bigInt(),
    note: s.string().nullable(),
  };
  const lineFields = {
    id: s.bigInt().id().increment(),
    sku: s.string(),
    basketId: s.int(),
    basket: s
      .toOne(() => basket)
      .fields("basketId")
      .references("id")
      .onDelete("cascade"),
    ...stamps(),
  };
  const line = s.model(
    incrementFirst
      ? { ...lineFields, ...counters }
      : { ...counters, ...lineFields }
  );
  const schema = incrementFirst ? { basket, line } : { line, basket };
  const client = createClient({ schema, dataDir: ":memory:" });
  await syncLiveSchema(client);
  // A model's where tree builds its fields' filters in declaration order, and
  // the first filter built for a kind is the one the process interns.
  if (incrementFirst) {
    await client.basket.count({ where: {} });
    await client.line.count({ where: {} });
  } else {
    await client.line.count({ where: {} });
    await client.basket.count({ where: {} });
  }
  return client;
};

type Store = Awaited<ReturnType<typeof openStore>>;
let store: Store | undefined;

afterEach(async () => {
  await store?.$disconnect();
  store = undefined;
});

describe.each([
  ["an increment id built first", true],
  ["plain counters built first", false],
] as const)("zero filters with %s", (_order, incrementFirst) => {
  test("root reads, counts and bulk writes match zero", async () => {
    const db = (store = await openStore(incrementFirst));
    // The increment ids keep their own create rule.
    await expect(
      db.basket.create({ data: { id: 0, ref: "zero" } })
    ).rejects.toThrow(ZERO_REFUSAL);
    await expect(
      db.line.create({
        data: { id: 0n, sku: "zero", qty: 0, units: 0n, basketId: 1 },
      })
    ).rejects.toThrow(ZERO_REFUSAL);
    for (let b = 1; b <= BASKETS; b++) {
      await db.basket.create({ data: { ref: `basket-${b}` } });
    }
    expect(await db.line.createMany({ data: rows })).toEqual({ count: LINES });

    const zeros = await db.line.findMany({ where: { qty: 0 } });
    expect(zeros).toHaveLength(where((r) => r.qty === 0));
    expect(zeros.every((row) => row.qty === 0)).toBe(true);
    expect(await db.line.count({ where: { qty: { equals: 0 } } })).toBe(
      where((r) => r.qty === 0)
    );
    expect(await db.line.count({ where: { qty: { not: 0 } } })).toBe(
      where((r) => r.qty !== 0)
    );
    expect(await db.line.count({ where: { units: 0n } })).toBe(
      where((r) => r.units === 0n)
    );
    expect(await db.line.count({ where: { units: { not: 0n } } })).toBe(
      where((r) => r.units !== 0n)
    );
    // A filter on the increment id itself selects nothing; it refuses nothing.
    expect(await db.line.findMany({ where: { id: 0n } })).toEqual([]);
    expect(await db.basket.findMany({ where: { id: 0 } })).toEqual([]);

    expect(
      await db.line.updateMany({
        where: { units: 0n },
        data: { note: "empty" },
      })
    ).toEqual({ count: where((r) => r.units === 0n) });
    expect(await db.line.count({ where: { note: "empty" } })).toBe(
      where((r) => r.units === 0n)
    );
    expect(await db.line.deleteMany({ where: { qty: 0 } })).toEqual({
      count: where((r) => r.qty === 0),
    });
    expect(await db.line.count()).toBe(where((r) => r.qty !== 0));
  });

  test("nested updateMany and deleteMany match zero", async () => {
    const db = (store = await openStore(incrementFirst));
    for (let b = 1; b <= BASKETS; b++) {
      await db.basket.create({ data: { ref: `basket-${b}` } });
    }
    await db.line.createMany({ data: rows });
    const inFirst = (keep: (row: (typeof rows)[number]) => boolean) =>
      where((r) => r.basketId === 1 && keep(r));

    const updated = await db.basket.update({
      where: { id: 1 },
      data: {
        lines: { updateMany: { where: { qty: 0 }, data: { qty: 9 } } },
      },
      include: { lines: true },
    });
    expect(updated.lines.filter((l) => l.qty === 9)).toHaveLength(
      inFirst((r) => r.qty === 0)
    );
    expect(updated.lines.some((l) => l.qty === 0)).toBe(false);

    const deleted = await db.basket.update({
      where: { id: 1 },
      data: { lines: { deleteMany: { units: { equals: 0n } } } },
      include: { lines: true },
    });
    expect(deleted.lines).toHaveLength(inFirst((r) => r.units !== 0n));

    const second = await db.basket.update({
      where: { id: 2 },
      data: { lines: { deleteMany: { qty: 0 } } },
      include: { lines: true },
    });
    expect(second.lines).toHaveLength(
      where((r) => r.basketId === 2 && r.qty !== 0)
    );
    // The other basket's zero rows are untouched.
    expect(await db.line.count({ where: { qty: 0 } })).toBe(
      where((r) => r.basketId === 3 && r.qty === 0)
    );
  });
});
