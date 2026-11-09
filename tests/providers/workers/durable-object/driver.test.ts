/**
 * `viborm/durable-object` on workerd: statements, typed errors, transactions
 * at every depth, batches and the platform limits. Ported from the contract
 * tests of the first Durable Object driver an application wrote (Flarion,
 * 2026-11), against the first-party driver.
 */
import type {
  DurableObjectState,
  DurableObjectStorage,
} from "@cloudflare/workers-types";
import { SQLiteAdapter } from "@src/adapters/databases/sqlite/sqlite-adapter";
import { DURABLE_OBJECT_MIGRATION_CAPABILITY } from "@src/drivers/driver";
import {
  createClient,
  createDurableObjectDriver,
} from "@src/drivers/durable-object";
import { createMigrationClient } from "@src/migrations/client";
import { s } from "@src/schema";
import { sql } from "@src/sql/sql";
import { describe, expect, test } from "vitest";
import { inObject } from "./objects";

const user = s
  .model({
    id: s.string().id(),
    name: s.string(),
    email: s.string().unique().nullable(),
    age: s.int().nullable(),
    big: s.bigInt().nullable(),
    active: s.boolean().default(true),
    joined: s.dateTime().nullable(),
    meta: s.json().nullable(),
    avatar: s.blob().nullable(),
    posts: s.toMany(() => post),
  })
  .map("users");
const post = s
  .model({
    id: s.string().id(),
    title: s.string(),
    views: s.int().default(0),
    authorId: s.string(),
    author: s
      .toOne(() => user)
      .fields("authorId")
      .references("id"),
  })
  .map("posts");
const schema = { user, post };
const ONE_HUNDRED = /100/;

function clientOf(storage: DurableObjectStorage) {
  return createClient({ storage, schema });
}

type Client = ReturnType<typeof clientOf>;

/** A fresh object whose schema was pushed by the driver itself. */
function withClient<T>(
  fn: (client: Client, state: DurableObjectState) => Promise<T>
): Promise<T> {
  return inObject(async (state) => {
    const client = clientOf(state.storage);
    const migrations = createMigrationClient(client);
    const preview = await migrations.push({ dryRun: true });
    await migrations.push({ consent: preview.consent });
    return fn(client, state);
  });
}

describe("Durable Object driver: statements", () => {
  test("one driver per storage, with the platform's limits", async () => {
    await withClient(async (client, state) => {
      const driver = createDurableObjectDriver(state.storage);
      expect(driver).toBe(createDurableObjectDriver(state.storage));
      expect(client.$driver).toBe(driver);
      expect(driver.maxBindParametersPerStatement).toBe(100);
      expect(driver.supportsTransactions).toBe(true);
      expect(driver.supportsBatch).toBe(false);
      expect(driver.sqliteMigrationCapability).toBe(
        DURABLE_OBJECT_MIGRATION_CAPABILITY
      );
      // `deepExpressions: false`: workerd's expression depth is 100.
      expect(driver.adapter).toBeInstanceOf(SQLiteAdapter);
      expect(driver.adapter.capabilities.boundsExpressionDepth).toBe(true);
    });
  });

  test("a wrapper keeping the storage's sql shares its driver, so its write waits for the open transaction", async () => {
    await withClient(async (client, state) => {
      expect(state.storage.sql).toBe(state.storage.sql);
      const wrapped = {
        sql: state.storage.sql,
        transaction: state.storage.transaction.bind(state.storage),
        sync: state.storage.sync.bind(state.storage),
      } as DurableObjectStorage;
      const other = clientOf(wrapped);
      expect(other.$driver).toBe(client.$driver);
      let opened: () => void = () => undefined;
      const open = new Promise<void>((resolve) => {
        opened = resolve;
      });
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const rolledBack = client
        .$transaction(async (tx) => {
          await tx.user.create({ data: { id: "in-tx", name: "x" } });
          opened();
          await gate;
          throw new Error("roll back");
        })
        .catch((error: Error) => error.message);
      await open;
      // `.then` starts the operation, which runs only once awaited.
      const written = other
        .$executeRawUnsafe("INSERT INTO users (id, name) VALUES ('other', 'o')")
        .then((count) => count);
      // Time for a second driver's write to reach SQLite inside the open one.
      await new Promise((resolve) => setTimeout(resolve, 20));
      release();
      expect(await rolledBack).toBe("roll back");
      expect(await written).toBe(1);
      expect(
        state.storage.sql.exec("SELECT id FROM users ORDER BY id").toArray()
      ).toEqual([{ id: "other" }]);
    });
  });

  test("an adapter is read when the storage's driver is created, and another one is refused later", async () => {
    await inObject(async (state) => {
      const adapter = new SQLiteAdapter({ temporaryObjects: false });
      const driver = createDurableObjectDriver(state.storage, adapter);
      expect(driver.adapter).toBe(adapter);
      expect(createDurableObjectDriver(state.storage, adapter)).toBe(driver);
      expect(createDurableObjectDriver(state.storage)).toBe(driver);
      expect(() =>
        createDurableObjectDriver(
          state.storage,
          new SQLiteAdapter({ temporaryObjects: false })
        )
      ).toThrow("already has a driver, created with another adapter");
    });
  });

  test("round-trips booleans, dates, JSON, BLOBs, bigints and nulls", async () => {
    await withClient(async (client) => {
      const joined = new Date("2026-11-07T10:00:00.000Z");
      await client.user.create({
        data: {
          id: "u1",
          name: "Ada",
          age: 36,
          big: 9_007_199_254_740_991n,
          active: false,
          joined,
          meta: { tags: ["a", "b"], n: 1 },
          avatar: new Uint8Array([1, 2, 3, 255]),
        },
      });
      const found = await client.user.findUniqueOrThrow({
        where: { id: "u1" },
      });
      expect(found.active).toBe(false);
      expect(found.joined).toEqual(joined);
      expect(found.big).toBe(9_007_199_254_740_991n);
      expect(found.meta).toEqual({ tags: ["a", "b"], n: 1 });
      expect([...(found.avatar ?? [])]).toEqual([1, 2, 3, 255]);
      expect(found.email).toBeNull();
      // A subarray binds its own bytes, not its whole buffer.
      const whole = new Uint8Array([9, 8, 7, 6]);
      await client.user.update({
        where: { id: "u1" },
        data: { avatar: whole.subarray(1, 3) },
      });
      const updated = await client.user.findUniqueOrThrow({
        where: { id: "u1" },
      });
      expect([...(updated.avatar ?? [])]).toEqual([8, 7]);
    });
  });

  test("a bigint past ±2^53 is stored exactly; raw SQL reads it as a rounded number", async () => {
    await withClient(async (client, state) => {
      await client.user.create({
        data: { id: "u1", name: "n", big: 9_007_199_254_740_993n },
      });
      expect(
        state.storage.sql
          .exec("SELECT CAST(big AS TEXT) AS exact FROM users")
          .one()
      ).toEqual({ exact: "9007199254740993" });
      expect(
        state.storage.sql.exec("SELECT typeof(big) AS type FROM users").one()
      ).toEqual({ type: "integer" });
    });
  });

  test("update, delete, count, updateMany and deleteMany report exact row counts", async () => {
    await withClient(async (client) => {
      await client.user.createMany({
        data: Array.from({ length: 30 }, (_, i) => ({
          id: `u${i}`,
          name: `n${i}`,
          age: i,
        })),
      });
      expect(await client.user.count()).toBe(30);
      expect(
        await client.user.updateMany({
          where: { age: { gte: 20 } },
          data: { name: "old" },
        })
      ).toEqual({ count: 10 });
      expect(await client.user.deleteMany({ where: { name: "old" } })).toEqual({
        count: 10,
      });
      expect(await client.user.count()).toBe(20);
    });
  });

  test("bulk inserts that need more than 100 bound values are split to fit the platform", async () => {
    await withClient(async (client, state) => {
      await client.user.createMany({
        data: Array.from({ length: 40 }, (_, i) => ({
          id: `b${i}`,
          name: `bulk${i}`,
        })),
      });
      expect(await client.user.count()).toBe(40);
      expect(
        state.storage.sql.exec("SELECT count(*) AS c FROM users").one()
      ).toEqual({ c: 40 });
    });
  });

  test("raw statements report their row counts", async () => {
    await withClient(async (client) => {
      expect(
        await client.$executeRaw(
          sql`INSERT INTO users (id, name, active) VALUES (${"r1"}, ${"Raw"}, ${1})`
        )
      ).toBe(1);
      expect(
        await client.$executeRaw(
          sql`UPDATE users SET name = ${"Raw2"} WHERE id = ${"r1"}`
        )
      ).toBe(1);
      expect(
        await client.$executeRaw(
          sql`UPDATE users SET name = ${"x"} WHERE id = ${"missing"}`
        )
      ).toBe(0);
      // DDL reports no row count of its own, not the previous statement's.
      expect(
        await client.$executeRawUnsafe("CREATE TABLE side (n INTEGER)")
      ).toBe(0);
      expect(
        await client.$queryRaw<{ name: string }>(
          sql`SELECT name FROM users WHERE id = ${"r1"}`
        )
      ).toEqual([{ name: "Raw2" }]);
    });
  });

  test("a long IN list is one bound value; a statement needing more than 100 is refused before SQLite", async () => {
    await withClient(async (client) => {
      const ids = Array.from({ length: 300 }, (_, i) => `id${i}`);
      expect(
        await client.user.findMany({ where: { id: { in: ids } } })
      ).toEqual([]);
      const failure = await client.user
        .findMany({
          where: {
            OR: ids.slice(0, 150).map((id, i) => ({ name: id, age: i })),
          },
        })
        .catch((error: unknown) => error);
      expect(failure).toMatchObject({ name: "UnsupportedOperationError" });
      expect(String((failure as Error).message)).toMatch(ONE_HUNDRED);
    });
  });
});

describe("Durable Object driver: errors", () => {
  test("constraint failures map to the typed errors with their columns", async () => {
    await withClient(async (client) => {
      await client.user.create({
        data: { id: "u1", name: "A", email: "a@x.dev" },
      });
      // workerd's errors carry no `code`: VibORM maps them from the message.
      await expect(
        client.user.create({ data: { id: "u2", name: "B", email: "a@x.dev" } })
      ).rejects.toMatchObject({
        name: "UniqueConstraintError",
        code: "V3001",
        meta: { columns: ["email"], table: "users" },
      });
      await expect(
        client.user.create({ data: { id: "u1", name: "C" } })
      ).rejects.toMatchObject({
        name: "UniqueConstraintError",
        code: "V3001",
        meta: { columns: ["id"], table: "users" },
      });
      await expect(
        client.post.create({
          data: { id: "p1", title: "t", authorId: "nobody" },
        })
      ).rejects.toMatchObject({ name: "ForeignKeyError", code: "V3002" });
      await client.post.create({
        data: { id: "p2", title: "t", authorId: "u1" },
      });
      await expect(
        client.user.delete({ where: { id: "u1" } })
      ).rejects.toMatchObject({ name: "ForeignKeyError", code: "V3002" });
    });
  });

  test("raw NOT NULL and CHECK failures map too, NOT NULL with its column", async () => {
    await withClient(async (client, state) => {
      await expect(
        client.$executeRawUnsafe("INSERT INTO users (id) VALUES (?)", "x")
      ).rejects.toMatchObject({
        name: "NotNullConstraintError",
        code: "V3003",
        meta: { columns: ["name"], table: "users" },
      });
      state.storage.sql.exec("CREATE TABLE checked (n INTEGER CHECK (n > 0))");
      await expect(
        client.$executeRawUnsafe("INSERT INTO checked VALUES (-1)")
      ).rejects.toMatchObject({
        name: "CheckConstraintError",
        code: "V3004",
      });
    });
  });

  test("a statement over the platform's 100 KB fails", async () => {
    await withClient(async (client) => {
      await expect(
        client.$queryRawUnsafe(`SELECT ${"1,".repeat(60_000)}1`)
      ).rejects.toBeInstanceOf(Error);
    });
  });
});

describe("Durable Object driver: transactions", () => {
  test("commits when the callback resolves and returns its value", async () => {
    await withClient(async (client) => {
      const result = await client.$transaction(async (tx) => {
        await tx.user.create({ data: { id: "u1", name: "A" } });
        await tx.user.create({ data: { id: "u2", name: "B" } });
        return (await tx.user.count()) * 10;
      });
      expect(result).toBe(20);
      expect(await client.user.count()).toBe(2);
    });
  });

  test("rolls back every write, before and after an await, when the callback throws", async () => {
    await withClient(async (client) => {
      await expect(
        client.$transaction(async (tx) => {
          await tx.user.create({ data: { id: "u1", name: "A" } });
          await new Promise((resolve) => queueMicrotask(() => resolve(null)));
          await tx.user.create({ data: { id: "u2", name: "B" } });
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");
      expect(await client.user.count()).toBe(0);
    });
  });

  test("rolls back on a constraint failure inside the transaction", async () => {
    await withClient(async (client) => {
      await client.user.create({ data: { id: "u1", name: "A" } });
      await expect(
        client.$transaction(async (tx) => {
          await tx.user.update({
            where: { id: "u1" },
            data: { name: "changed" },
          });
          await tx.post.create({
            data: { id: "p1", title: "t", authorId: "nobody" },
          });
        })
      ).rejects.toMatchObject({ name: "ForeignKeyError" });
      expect(
        (await client.user.findUniqueOrThrow({ where: { id: "u1" } })).name
      ).toBe("A");
    });
  });

  test("a nested $transaction is a native frame: its rollback keeps the outer writes, at every depth", async () => {
    await withClient(async (client) => {
      await client.$transaction(async (tx) => {
        await tx.user.create({ data: { id: "outer", name: "o" } });
        await tx
          .$transaction(async (inner) => {
            await inner.user.create({ data: { id: "inner", name: "i" } });
            // A third level, committed, then rolled back with its parent.
            await inner.$transaction(async (deep) => {
              await deep.user.create({ data: { id: "deep", name: "d" } });
            });
            throw new Error("inner failed");
          })
          .catch((error: Error) => expect(error.message).toBe("inner failed"));
        await tx.$transaction(async (sibling) => {
          await sibling.user.create({ data: { id: "sibling", name: "s" } });
          await sibling
            .$transaction(async (deep) => {
              await deep.user.create({ data: { id: "lost", name: "l" } });
              throw new Error("deep failed");
            })
            .catch(() => undefined);
        });
        await tx.user.create({ data: { id: "after", name: "a" } });
      });
      const ids = (
        await client.user.findMany({
          select: { id: true },
          orderBy: { id: "asc" },
        })
      ).map(({ id }) => id);
      expect(ids).toEqual(["after", "outer", "sibling"]);
    });
  });

  test("an outer rollback undoes committed nested transactions", async () => {
    await withClient(async (client) => {
      await expect(
        client.$transaction(async (tx) => {
          await tx.$transaction(async (inner) => {
            await inner.user.create({ data: { id: "inner", name: "i" } });
          });
          throw new Error("outer failed");
        })
      ).rejects.toThrow("outer failed");
      expect(await client.user.count()).toBe(0);
    });
  });

  test("$transaction([...]) is atomic and ordered", async () => {
    await withClient(async (client) => {
      const [created, count] = await client.$transaction([
        client.user.create({ data: { id: "b1", name: "b" } }),
        client.user.count(),
      ]);
      expect(created.id).toBe("b1");
      expect(count).toBe(1);
      await expect(
        client.$transaction([
          client.user.create({ data: { id: "b2", name: "b" } }),
          client.user.create({ data: { id: "b1", name: "duplicate" } }),
        ])
      ).rejects.toMatchObject({ name: "UniqueConstraintError" });
      expect(await client.user.count()).toBe(1);
    });
  });

  test("concurrent transactions are serialized and other callers wait their turn", async () => {
    await withClient(async (client) => {
      await client.user.create({ data: { id: "counter", name: "c", age: 0 } });
      const bump = () =>
        client.$transaction(async (tx) => {
          const row = await tx.user.findUniqueOrThrow({
            where: { id: "counter" },
          });
          await Promise.resolve();
          await tx.user.update({
            where: { id: "counter" },
            data: { age: (row.age ?? 0) + 1 },
          });
        });
      const observer = client.user.count();
      await Promise.all(Array.from({ length: 10 }, bump));
      await observer;
      expect(
        (await client.user.findUniqueOrThrow({ where: { id: "counter" } })).age
      ).toBe(10);
    });
  });

  test("the timeout option rolls the transaction back", async () => {
    await withClient(async (client) => {
      await expect(
        client.$transaction(
          async (tx) => {
            await tx.user.create({ data: { id: "slow", name: "s" } });
            await new Promise((resolve) => setTimeout(resolve, 200));
          },
          { timeout: 20 }
        )
      ).rejects.toBeInstanceOf(Error);
      expect(await client.user.count()).toBe(0);
    });
  });

  test("only Serializable is honoured", async () => {
    await withClient(async (client) => {
      await expect(
        client.$transaction(async () => 1, {
          isolationLevel: "Serializable",
        })
      ).resolves.toBe(1);
      await expect(
        client.$transaction(async () => 1, {
          isolationLevel: "ReadCommitted",
        })
      ).rejects.toMatchObject({ name: "UnsupportedOperationError" });
    });
  });
});
