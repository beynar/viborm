import { MemoryCache } from "@cache/drivers/memory";
import { cache } from "@cache/extension";
import { createClient as createCoreClient } from "@client/client";
import { createClient } from "@drivers/sqlite3";
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
  "definition",
  "temporal",
])("a %s change after admission is refused atomically before the write", async (change) => {
  const handle = new Database(":memory:");
  handle.pragma("foreign_keys = ON");
  let armed = false;
  const observed: (string | undefined)[] = [];
  const client = createClient({
    client: handle,
    schema: { product, event },
  }).$extends({
    name: "change-storage-after-admission",
    statement(context) {
      observed.push(context.model);
      if (armed) {
        armed = false;
        if (change === "definition") {
          handle.exec(
            "ALTER TABLE product RENAME TO previous_product; CREATE TABLE product (id INTEGER PRIMARY KEY, price REAL NOT NULL); INSERT INTO product VALUES (1, 89.5)"
          );
        } else {
          handle.exec("UPDATE event SET at = '2024-01-01T12:00:00+00:00'");
        }
      }
      return context.statement;
    },
  });
  try {
    await syncLiveSchema(client);
    await client.product.create({ data: { id: 1, price: "89.50" } });
    await client.event.create({ data: { id: 1, at: "2024-01-01T12:00:00Z" } });
    observed.length = 0;
    armed = true;
    await expect(
      change === "definition"
        ? client.product.deleteMany()
        : client.event.deleteMany()
    ).rejects.toThrow("changed");
    expect(observed).not.toContain("$schema");
    expect(
      handle
        .prepare(
          change === "definition"
            ? "SELECT id FROM product"
            : "SELECT id FROM event"
        )
        .all()
    ).toEqual([{ id: 1 }]);
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

test("noncanonical legacy timestamps refuse predicates and cached reads", async () => {
  const storage = new MemoryCache();
  const client = createClient({ schema: { event } }).$extends(
    cache({ driver: storage })
  );
  try {
    await syncLiveSchema(client);
    await client.event.create({ data: { id: 1, at: "2024-01-01T12:00:00Z" } });
    expect(await client.$withCache({ ttl: 60 }).event.count()).toBe(1);
    await client.$executeRawUnsafe(
      "UPDATE event SET at = '2024-01-01T12:00:00+00:00'"
    );
    await expect(
      client.event.deleteMany({ where: { at: { lt: "2024-01-01T13:00:00Z" } } })
    ).rejects.toThrow("canonical UTC text");
    await expect(client.$withCache({ ttl: 60 }).event.count()).rejects.toThrow(
      "canonical UTC text"
    );
    expect(await client.$queryRawUnsafe("SELECT id FROM event")).toEqual([
      { id: 1 },
    ]);
  } finally {
    await client.$disconnect();
    await storage.disconnect();
  }
});

test("foreign canonical-looking calendar and clock values cannot reach predicates", async () => {
  const schedule = s.model({
    id: s.int().id(),
    at: s.dateTime(),
    time: s.time(),
  });
  const client = createClient({ schema: { schedule } });
  try {
    await client.$executeRawUnsafe(
      "CREATE TABLE schedule (id INTEGER PRIMARY KEY, at TEXT NOT NULL, time TEXT NOT NULL)"
    );
    await client.$executeRawUnsafe(
      "INSERT INTO schedule VALUES (1, '2024-01-01T00:00:00.000Z', '12:30:59.999')"
    );
    expect(await client.schedule.count()).toBe(1);
    for (const [at, time] of [
      ["2024-02-30T00:00:00.000Z", "12:30:59.999"],
      ["2024-01-01T25:00:00.000Z", "12:30:59.999"],
      ["2024-01-01T00:00:00.000Z", "24:99:99.000"],
    ]) {
      await client.$executeRawUnsafe(
        "UPDATE schedule SET at = ?, time = ?",
        at,
        time
      );
      await expect(
        client.schedule.deleteMany({ where: { id: 1 } })
      ).rejects.toThrow("canonical UTC text");
      expect(await client.$queryRawUnsafe("SELECT id FROM schedule")).toEqual([
        { id: 1 },
      ]);
    }
  } finally {
    await client.$disconnect();
  }
});

test("foreign temporal list spellings cannot silently change member filters", async () => {
  const schedule = s.model({ id: s.int().id(), moments: s.dateTime().array() });
  const client = createClient({ schema: { schedule } });
  try {
    await syncLiveSchema(client);
    await client.schedule.create({
      data: { id: 1, moments: ["2024-01-01T00:00:00Z"] },
    });
    expect(
      await client.schedule.count({
        where: { moments: { has: "2024-01-01T00:00:00Z" } },
      })
    ).toBe(1);
    await client.$executeRawUnsafe(
      "UPDATE schedule SET moments = ?",
      '["2024-01-01T00:00:00+00:00"]'
    );
    await expect(
      client.schedule.deleteMany({
        where: { moments: { has: "2024-01-01T00:00:00Z" } },
      })
    ).rejects.toThrow("canonical UTC text");
    expect(await client.$queryRawUnsafe("SELECT id FROM schedule")).toEqual([
      { id: 1 },
    ]);
  } finally {
    await client.$disconnect();
  }
});
