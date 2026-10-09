import { sqliteNoncanonicalTemporalCount } from "@adapters/databases/sqlite/storage/datetime";
import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient as createCoreClient } from "@client/client";
import { createClient } from "@drivers/sqlite3";
import type {
  LifecycleUnit,
  ObservationCompletion,
} from "@extensions/observation";
import {
  sqliteCanonicalDateTimeExpression,
  sqliteCanonicalTimeExpression,
} from "@migrations";
import { s } from "@schema";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { BatchOnlyLibSQLDriver } from "./libsql-fixtures";

const product = s.model({
  id: s.int().id(),
  price: s.decimal({ precision: 10, scale: 2 }),
});
const event = s.model({ id: s.int().id(), at: s.dateTime() });

test("storage checks cover only tables used by this operation, including cached reads", async () => {
  const plain = s.model({ id: s.int().id() });
  const storage = new MemoryCache();
  const client = createClient({ schema: { plain, product, event } }).$extends(
    cache({ driver: storage })
  );
  try {
    await client.$executeRawUnsafe(
      "CREATE TABLE plain (id INTEGER PRIMARY KEY)"
    );
    await client.plain.create({ data: { id: 1 } });
    expect(await client.$withCache({ ttl: 60 }).plain.count()).toBe(1);
    expect(await client.$withCache({ ttl: 60 }).plain.count()).toBe(1);
    expect(await client.plain.deleteMany()).toEqual({ count: 1 });
  } finally {
    await client.$disconnect();
    await storage.disconnect();
  }
});

test.each([
  false,
  true,
])("a definition change after admission is refused atomically before the write, observing:%s", async (observing) => {
  const handle = new Database(":memory:");
  handle.pragma("foreign_keys = ON");
  let armed = false;
  const observed: (string | undefined)[] = [];
  const statementModels: (string | undefined)[] = [];
  const client = createClient({
    client: handle,
    schema: { product },
  }).$extends({
    name: "change-storage-after-admission",
    ...(observing
      ? {
          observe(
            unit: LifecycleUnit,
            proceed: () => Promise<ObservationCompletion>
          ) {
            if (unit.kind === "statement") statementModels.push(unit.model);
            return proceed();
          },
        }
      : {}),
    statement(context) {
      observed.push(context.model);
      if (armed) {
        armed = false;
        handle.exec(
          "ALTER TABLE product RENAME TO previous_product; CREATE TABLE product (id INTEGER PRIMARY KEY, price REAL NOT NULL); INSERT INTO product VALUES (1, 89.5)"
        );
      }
      return context.statement;
    },
  });
  try {
    await syncLiveSchema(client);
    await client.product.create({ data: { id: 1, price: "89.50" } });
    observed.length = 0;
    statementModels.length = 0;
    armed = true;
    await expect(client.product.deleteMany()).rejects.toThrow("changed");
    expect(observed).not.toContain("$schema");
    if (observing) {
      expect(statementModels).toContain("$schema");
      expect(statementModels.filter((model) => model !== "$schema")).toEqual(
        observed
      );
    }
    expect(handle.prepare("SELECT id FROM product").all()).toEqual([{ id: 1 }]);
  } finally {
    await client.$disconnect();
    handle.close();
  }
});

test("safe raw SQL refuses a forged fragment from JSON", async () => {
  const client = createClient({ schema: { product } });
  try {
    const forged = { strings: ["SELECT 'injected' AS value"], values: [] };
    // @ts-expect-error Runtime JSON input is not an Sql instance.
    await expect(client.$queryRaw(forged)).rejects.toThrow("neither");
  } finally {
    await client.$disconnect();
  }
});

test("foreign decimal filters and writes are refused before their effects", async () => {
  const client = createClient({ schema: { product } });
  try {
    await client.$executeRawUnsafe(
      "CREATE TABLE product (id INTEGER PRIMARY KEY, price DECIMAL(10,2) NOT NULL)"
    );
    await client.$executeRawUnsafe("INSERT INTO product VALUES (1, 89.5)");
    await expect(
      client.product.findMany({ where: { price: { lt: "50" } } })
    ).rejects.toThrow("scaled-integer");
    await expect(
      client.product.updateMany({ data: { price: "59.98" } })
    ).rejects.toThrow("scaled-integer");
    await expect(
      client.product.deleteMany({ where: { price: { lt: "50" } } })
    ).rejects.toThrow("scaled-integer");
    expect(await client.$queryRawUnsafe("SELECT price FROM product")).toEqual([
      { price: 89.5 },
    ]);
  } finally {
    await client.$disconnect();
  }
});

test("a declared decimal works in direct, callback and array transactions", async () => {
  const client = createClient({ schema: { product } });
  try {
    await syncLiveSchema(client);
    await client.product.create({ data: { id: 1, price: "89.50" } });
    expect(
      (
        await client.product.findUniqueOrThrow({ where: { id: 1 } })
      ).price.toString()
    ).toBe("89.5");
    await client.$transaction(async (tx) => {
      await tx.product.update({ where: { id: 1 }, data: { price: "59.98" } });
    });
    const [count] = await client.$transaction([
      client.product.count({ where: { price: { lt: "60" } } }),
    ]);
    expect(count).toBe(1);
  } finally {
    await client.$disconnect();
  }
});

test("native libSQL array preparation cannot bypass the carrier check", async () => {
  const client = createCoreClient({
    schema: { product },
    driver: new BatchOnlyLibSQLDriver({ databaseUrl: "file::memory:" }),
  });
  try {
    await client.$executeRawUnsafe(
      "CREATE TABLE product (id INTEGER PRIMARY KEY, price REAL NOT NULL)"
    );
    await client.$executeRawUnsafe("INSERT INTO product VALUES (1, 89.5)");
    await expect(
      client.$transaction([
        client.product.updateMany({ data: { price: "59.98" } }),
      ])
    ).rejects.toThrow("scaled-integer");
    expect(await client.$queryRawUnsafe("SELECT price FROM product")).toEqual([
      { price: 89.5 },
    ]);
  } finally {
    await client.$disconnect();
  }
});

test("a successful read does not attest a later replacement table", async () => {
  const client = createClient({ schema: { product } });
  try {
    await syncLiveSchema(client);
    await client.product.create({ data: { id: 1, price: "89.50" } });
    expect(await client.product.count()).toBe(1);
    await client.$executeRawUnsafe("ALTER TABLE product RENAME TO old_product");
    await client.$executeRawUnsafe(
      "CREATE TABLE product (id INTEGER PRIMARY KEY, price REAL NOT NULL)"
    );
    await expect(
      client.product.create({ data: { id: 2, price: "59.98" } })
    ).rejects.toThrow("scaled-integer");
    expect(
      await client.$queryRawUnsafe("SELECT count(*) AS n FROM product")
    ).toEqual([{ n: 0 }]);
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
