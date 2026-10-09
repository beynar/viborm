import { sqliteNoncanonicalTemporalCount } from "@adapters/databases/sqlite/storage/datetime";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient } from "@drivers/sqlite3";
import { VibORMErrorCode } from "@errors";
import {
  sqliteCanonicalDateTimeExpression,
  sqliteCanonicalTimeExpression,
} from "@migrations";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { expect, test } from "vitest";

const product = s.model({
  id: s.int().id(),
  price: s.decimal({ precision: 10, scale: 2 }),
});

/**
 * VibORM-owned SQLite schemas are correct by construction and typed queries do
 * not inspect storage. A decimal column another tool created is adopted
 * through push/migrate (which refuse it) or audited with `viborm check --db`.
 * Until then it is unprotected: the "documented gap" assertions below record
 * today's behavior as described in docs/content/docs/migration/drivers/sqlite.mdx,
 * not a contract to preserve.
 */
test("a foreign REAL decimal column fails typed reads closed", async () => {
  const client = createClient({ schema: { product } });
  try {
    await client.$executeRawUnsafe(
      "CREATE TABLE product (id INTEGER PRIMARY KEY, price REAL NOT NULL)"
    );
    await client.$executeRawUnsafe(
      "INSERT INTO product VALUES (1, 89.5), (2, 3)"
    );
    const invalid = { code: VibORMErrorCode.QUERY_RESULT_INVALID };
    await expect(client.product.findMany()).rejects.toMatchObject(invalid);
    // Documented gap: a write stores the scaled coefficient, and only its
    // RETURNING decode fails.
    await expect(
      client.product.create({ data: { id: 3, price: "9.99" } })
    ).rejects.toMatchObject(invalid);
    expect(
      await client.$queryRawUnsafe("SELECT price FROM product WHERE id = 3")
    ).toEqual([{ price: 999 }]);
  } finally {
    await client.$disconnect();
  }
});

test("a foreign DECIMAL(10,2) column is misread without an error and is refused by push", async () => {
  const client = createClient({ schema: { product } });
  try {
    // What other tools declare: NUMERIC affinity stores whole numbers as integers.
    await client.$executeRawUnsafe(
      "CREATE TABLE product (id INTEGER PRIMARY KEY, price DECIMAL(10,2) NOT NULL)"
    );
    await client.$executeRawUnsafe(
      "INSERT INTO product VALUES (1, 3), (2, 150), (3, '12.00')"
    );
    await expect(
      syncLiveSchema(client, { dryRun: true })
    ).rejects.toMatchObject({
      code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      message: expect.stringContaining("unmarked DECIMAL(10,2) storage"),
    });
    // Documented gap: each stored integer reads as a scaled coefficient.
    const prices = await client.product.findMany({ orderBy: { id: "asc" } });
    expect(prices.map(({ price }) => price.toString())).toEqual([
      "0.03",
      "1.5",
      "0.12",
    ]);
    const { _sum } = await client.product.aggregate({ _sum: { price: true } });
    expect(_sum.price?.toString()).toBe("1.65");
    // Documented gap: a filtered mutation compares coefficients, so `< 100`
    // (coefficient 10000) also deletes the row holding 150.
    expect(
      await client.product.deleteMany({ where: { price: { lt: "100" } } })
    ).toEqual({ count: 3 });
  } finally {
    await client.$disconnect();
  }
});

const legacy = s
  .model({
    id: s.int().id(),
    title: s.string(),
    at: s.dateTime(),
    clock: s.time(),
    moments: s.dateTime().array(),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("legacy_event");

const LEGACY_COLUMNS = [
  ["at", "datetime", false],
  ["clock", "time", false],
  ["moments", "datetime", true],
  ["createdAt", "datetime", false],
  ["updatedAt", "datetime", false],
] as const;

async function noncanonical(client: {
  $queryRawUnsafe(sql: string): Promise<unknown>;
}): Promise<Record<string, unknown>> {
  const counts: Record<string, unknown> = {};
  for (const [column, type, list] of LEGACY_COLUMNS)
    counts[column] = await client.$queryRawUnsafe(
      sqliteNoncanonicalTemporalCount("legacy_event", column, type, list)
    );
  return counts;
}

test("a noncanonical legacy row no longer takes its model offline; the audit counts it and the repair fixes it", async () => {
  const storage = new MemoryCache();
  const client = createClient({ schema: { legacy } }).$extends(
    cache({ driver: storage })
  );
  try {
    await syncLiveSchema(client);
    await client.legacy.createMany({
      data: [1, 2, 3].map((id) => ({
        id,
        title: `event ${id}`,
        at: `2024-01-1${id}T10:30:00Z`,
        clock: "12:30:00",
        moments: [`2024-01-1${id}T10:30:00Z`],
      })),
    });
    expect(await client.$withCache({ ttl: 60 }).legacy.count()).toBe(3);
    // rc.x stored string input verbatim; SQLite's datetime('now') has no zone.
    await client.$executeRawUnsafe(
      `UPDATE legacy_event SET at = '2024-01-13T10:30:00Z', clock = '12:30:00', moments = '["2024-01-13T10:30:00+00:00"]', "createdAt" = datetime('now') WHERE id = 3`
    );
    const one = { at: 1, clock: 1, moments: 1, createdAt: 1, updatedAt: 0 };
    const counted = (counts: Record<string, number>) =>
      Object.fromEntries(
        Object.entries(counts).map(([column, n]) => [
          column,
          [{ noncanonical: n }],
        ])
      );
    expect(await noncanonical(client)).toEqual(counted(one));

    expect(
      await client.legacy.findUnique({ where: { id: 1 }, select: { id: true } })
    ).toEqual({ id: 1 });
    expect(await client.$withCache({ ttl: 60 }).legacy.count()).toBe(3);
    expect(
      await client.legacy.findMany({
        where: { title: "event 3" },
        select: { at: true, clock: true, moments: true },
      })
    ).toEqual([
      {
        at: new Date("2024-01-13T10:30:00Z"),
        clock: "12:30:00",
        moments: [new Date("2024-01-13T10:30:00Z")],
      },
    ]);
    await client.legacy.update({ where: { id: 1 }, data: { title: "edited" } });
    await client.legacy.create({
      data: {
        id: 4,
        title: "new",
        at: new Date(),
        clock: "08:00:00",
        moments: [],
      },
    });
    // Comparisons assume canonical storage: the legacy spelling is missed.
    const sameInstant = { at: { equals: new Date("2024-01-13T10:30:00Z") } };
    expect(await client.legacy.count({ where: sameInstant })).toBe(0);

    // The helper refuses zone-less text; this writer is known to write UTC.
    await expect(
      client.$executeRawUnsafe(
        `UPDATE legacy_event SET "createdAt" = ${sqliteCanonicalDateTimeExpression("createdAt")}`
      )
    ).rejects.toThrow("numeric range");
    await client.$executeRawUnsafe(
      `UPDATE legacy_event SET "createdAt" = replace("createdAt", ' ', 'T') || 'Z' WHERE "createdAt" GLOB '????-??-?? ??:??:??'`
    );
    await client.$executeRawUnsafe(
      `UPDATE legacy_event SET at = ${sqliteCanonicalDateTimeExpression("at")}, clock = ${sqliteCanonicalTimeExpression("clock")}, "createdAt" = ${sqliteCanonicalDateTimeExpression("createdAt")}`
    );
    // A list is rewritten through the typed client, which stores canonical members.
    const { moments } = await client.legacy.findUniqueOrThrow({
      where: { id: 3 },
    });
    await client.legacy.update({ where: { id: 3 }, data: { moments } });
    expect(await noncanonical(client)).toEqual(
      counted({ at: 0, clock: 0, moments: 0, createdAt: 0, updatedAt: 0 })
    );
    expect(await client.legacy.count({ where: sameInstant })).toBe(1);
    expect(await client.legacy.delete({ where: { id: 3 } })).toMatchObject({
      id: 3,
    });
  } finally {
    await client.$disconnect();
    await storage.disconnect();
  }
});

test("the audit counts invalid calendar and clock text while typed access stays online", async () => {
  const client = createClient({ schema: { legacy } });
  try {
    await syncLiveSchema(client);
    for (const [id, at, clock] of [
      [1, "2024-01-01T00:00:00.000Z", "12:30:59.999"],
      [2, "2024-02-30T00:00:00.000Z", "12:30:59.999"],
      [3, "2024-01-01T25:00:00.000Z", "12:30:59.999"],
      [4, "2024-01-01T00:00:00.000Z", "24:99:99.000"],
    ] as const)
      await client.$executeRawUnsafe(
        `INSERT INTO legacy_event VALUES (?, 'raw', ?, ?, ?, '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z')`,
        id,
        at,
        clock,
        id === 4 ? '["2024-01-01"]' : `["${at}"]`
      );
    expect(await noncanonical(client)).toMatchObject({
      at: [{ noncanonical: 2 }],
      clock: [{ noncanonical: 1 }],
      moments: [{ noncanonical: 3 }],
    });
    expect(await client.legacy.count()).toBe(4);
    expect(await client.legacy.deleteMany({ where: { id: 1 } })).toEqual({
      count: 1,
    });
  } finally {
    await client.$disconnect();
  }
});
