import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createClient as createLibSQLTransport } from "@libsql/client";
import { sql } from "@sql";
import { createClient, s } from "@src/index";
import { qualifyRawDateCutoff } from "@tests/fixtures/raw-date-cutoff";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

function latch() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe("V1 driver data integrity regressions", () => {
  it.each([
    {
      name: "sqlite3",
      make: () => new SQLite3Driver(),
      integer: (n: number) => n,
    },
    {
      name: "libsql",
      make: () => new LibSQLDriver(),
      integer: (n: number) => BigInt(n),
    },
  ])("raw Date cutoff matches ISO text through $name", async ({
    make,
    integer,
  }) => {
    const client = createClient({
      schema: { entry: s.model({ id: s.int().id() }) },
      driver: make(),
    });
    try {
      await qualifyRawDateCutoff(client, integer);
    } finally {
      await client.$disconnect();
    }
  });

  it("safe and unsafe raw reads retain the same exact INTEGER vocabulary", async () => {
    const driver = new SQLite3Driver();
    const client = createClient({
      schema: { evidence: s.model({ id: s.int().id() }) },
      driver,
    });
    const text =
      "SELECT 7 AS small, 9007199254740993 AS large, -9007199254740993 AS negative";
    const query = sql`SELECT 7 AS small, 9007199254740993 AS large, -9007199254740993 AS negative`;
    const expected = [
      { small: 7, large: 9007199254740993n, negative: -9007199254740993n },
    ];
    try {
      expect((await driver._executeRaw(text)).rows).toEqual(expected);
      expect(await client.$queryRaw(query)).toEqual(expected);
      expect(await client.$queryRawUnsafe(text)).toEqual(expected);
      expect(
        await client.$transaction([
          client.$queryRaw(query),
          client.$queryRawUnsafe(text),
        ])
      ).toEqual([expected, expected]);
      await client.$transaction(async (tx) => {
        expect(await tx.$queryRaw(query)).toEqual(expected);
        expect(await tx.$queryRawUnsafe(text)).toEqual(expected);
      });
    } finally {
      await client.$disconnect();
    }
  });

  it("owned WAL transactions acquire the writer before a read-first update", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-v1-wal-"));
    const path = join(directory, "evidence.sqlite");
    const peer = new Database(path);
    const client = createClient({
      schema: { evidence: s.model({ id: s.int().id(), value: s.int() }) },
      driver: new SQLite3Driver({ dataDir: path }),
    });
    try {
      peer.pragma("journal_mode = WAL");
      peer.pragma("busy_timeout = 0");
      peer.exec(
        "CREATE TABLE evidence (id INTEGER PRIMARY KEY, value INTEGER NOT NULL)"
      );
      peer.prepare("INSERT INTO evidence VALUES (?, ?)").run(1, 10);
      await client.$transaction(async (tx) => {
        expect(await tx.evidence.findUnique({ where: { id: 1 } })).toEqual({
          id: 1,
          value: 10,
        });
        // A different native connection cannot invalidate the read snapshot:
        // the owned transaction already acquired the reserved writer lock.
        expect(() =>
          peer.prepare("INSERT INTO evidence VALUES (?, ?)").run(2, 20)
        ).toThrow(expect.objectContaining({ code: "SQLITE_BUSY" }));
        expect(
          await tx.evidence.update({ where: { id: 1 }, data: { value: 11 } })
        ).toEqual({ id: 1, value: 11 });
      });
      expect(peer.prepare("SELECT * FROM evidence").all()).toEqual([
        { id: 1, value: 11 },
      ]);
      peer.prepare("INSERT INTO evidence VALUES (?, ?)").run(2, 20);
      expect(await client.evidence.count()).toBe(2);
    } finally {
      try {
        await client.$disconnect();
      } finally {
        peer.close();
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("queues independent wrappers behind the actual SQLite handle and refuses reentry", async () => {
    const handle = new Database(":memory:");
    const a = new SQLite3Driver({ client: handle });
    const b = new SQLite3Driver({ client: handle });
    handle.exec("CREATE TABLE evidence (id INTEGER PRIMARY KEY)");
    const started = latch();
    const finish = latch();
    const failure = new Error("roll back this transaction");
    try {
      const transaction = a.withTransaction(async (tx) => {
        await tx._executeRaw("INSERT INTO evidence VALUES (1)");
        await expect(
          b._executeRaw("INSERT INTO evidence VALUES (3)")
        ).rejects.toMatchObject({ name: "TransactionError" });
        started.release();
        await finish.promise;
        throw failure;
      });
      const caught = transaction.catch((error: unknown) => error);
      await started.promise;
      const outside = b._executeRaw("INSERT INTO evidence VALUES (2)");
      let acknowledged = false;
      outside.then(() => {
        acknowledged = true;
      });
      await expect(
        b.withTransaction(async () => undefined, { maxWait: 10 })
      ).rejects.toMatchObject({ code: "V5002" });
      expect(acknowledged).toBe(false);
      finish.release();
      expect(await caught).toBe(failure);
      await outside;
      expect((await b._executeRaw("SELECT id FROM evidence")).rows).toEqual([
        { id: 2 },
      ]);
      await a._disconnect();
      expect(handle.open).toBe(true);
    } finally {
      finish.release();
      await b._disconnect();
      handle.close();
    }
  });

  it("outer timeout drains a pending nested callback and preserves handle recovery", async () => {
    const driver = new SQLite3Driver();
    const abandon = latch();
    const started = latch();
    let child:
      | Parameters<Parameters<typeof driver.withTransaction>[0]>[0]
      | undefined;
    try {
      await driver._executeRaw("CREATE TABLE evidence (id INTEGER)");
      const transaction = driver.withTransaction(
        async (outer) => {
          await outer.withTransaction(async (nested) => {
            child = nested;
            await nested._executeRaw("INSERT INTO evidence VALUES (1)");
            started.release();
            await abandon.promise;
          });
        },
        { timeout: 50 }
      );
      const caught = transaction.catch((error: unknown) => error);
      await started.promise;
      expect(await caught).toMatchObject({ code: "V5002" });
      expect((await driver._executeRaw("SELECT * FROM evidence")).rows).toEqual(
        []
      );
      await expect(
        child?._executeRaw("INSERT INTO evidence VALUES (2)")
      ).rejects.toMatchObject({ name: "TransactionError" });
    } finally {
      abandon.release();
      await driver._disconnect();
    }
  });

  it("a failed SQLite COMMIT rolls back and retains the in-memory database", async () => {
    const driver = new SQLite3Driver();
    try {
      await driver._executeRaw("CREATE TABLE parent (id INTEGER PRIMARY KEY)");
      await driver._executeRaw(
        "CREATE TABLE child (parent_id INTEGER REFERENCES parent(id) DEFERRABLE INITIALLY DEFERRED)"
      );
      await expect(
        driver.withTransaction(async (tx) => {
          await tx._executeRaw("INSERT INTO child VALUES (42)");
        })
      ).rejects.toMatchObject({ name: "ForeignKeyError" });
      expect((await driver._executeRaw("SELECT * FROM child")).rows).toEqual(
        []
      );
      await driver._executeRaw("INSERT INTO parent VALUES (42)");
      expect((await driver._executeRaw("SELECT id FROM parent")).rows).toEqual([
        { id: 42 },
      ]);
    } finally {
      await driver._disconnect();
    }
  });

  it("a failed BEGIN never rolls back or closes a supplied caller transaction", async () => {
    const handle = new Database(":memory:");
    const driver = new SQLite3Driver({ client: handle });
    try {
      handle.exec(
        "CREATE TABLE evidence (id INTEGER); BEGIN; INSERT INTO evidence VALUES (1)"
      );
      await expect(
        driver.withTransaction(async () => undefined)
      ).rejects.toThrow();
      expect(handle.inTransaction).toBe(true);
      handle.exec("COMMIT");
      expect(
        (await driver._executeRaw("SELECT id FROM evidence")).rows
      ).toEqual([{ id: 1 }]);
    } finally {
      await driver._disconnect();
      handle.close();
    }
  });

  it("modern in-memory libSQL transactions roll back atomically and retain supplied ownership", async () => {
    const transport = createLibSQLTransport({
      url: "file::memory:",
      intMode: "bigint",
    });
    const driver = new LibSQLDriver({ client: transport });
    try {
      await driver._executeRaw("CREATE TABLE evidence (id INTEGER)");
      const failure = new Error("abort");
      await expect(
        driver.withTransaction(async (tx) => {
          await tx._executeRaw("INSERT INTO evidence VALUES (1)");
          throw failure;
        })
      ).rejects.toBe(failure);
      expect((await driver._executeRaw("SELECT * FROM evidence")).rows).toEqual(
        []
      );
      await driver._disconnect();
      expect(transport.closed).toBe(false);
      await driver._executeRaw("INSERT INTO evidence VALUES (2)");
      expect(
        (await driver._executeRaw("SELECT id FROM evidence")).rows
      ).toEqual([{ id: 2n }]);
    } finally {
      await driver._disconnect();
      transport.close();
    }
  });

  it.each([
    false,
    true,
  ])("local libSQL raw BUSY quarantines only its client (supplied=%s)", async (supplied) => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-v1-busy-"));
    const url = `file:${join(directory, "evidence.sqlite")}`;
    const transport = createLibSQLTransport({
      url,
      intMode: "bigint",
      timeout: 0,
    });
    const driver = new LibSQLDriver(
      supplied
        ? { client: transport }
        : { databaseUrl: url, options: { timeout: 0 } }
    );
    const sibling = supplied
      ? new LibSQLDriver({ client: transport })
      : undefined;
    const holder = createLibSQLTransport({
      url,
      intMode: "bigint",
      timeout: 0,
    });
    let held: Awaited<ReturnType<typeof holder.transaction>> | undefined;
    try {
      await driver._executeRaw("PRAGMA foreign_keys = OFF");
      expect((await driver._executeRaw("PRAGMA foreign_keys")).rows).toEqual([
        { foreign_keys: 0n },
      ]);
      await driver._executeRaw("PRAGMA foreign_keys = ON");
      await driver._executeRaw("VACUUM");
      await driver._executeRaw("CREATE TABLE evidence (id INTEGER)");
      held = await holder.transaction("write");
      await held.execute("INSERT INTO evidence VALUES (1)");
      await expect(
        driver._executeRaw("INSERT INTO evidence VALUES (2)")
      ).rejects.toThrow();
      await held.commit();
      await expect(
        driver._executeRaw("INSERT INTO evidence VALUES (3)")
      ).rejects.toMatchObject({ code: "V1003" });
      if (sibling) {
        await expect(sibling._connect()).rejects.toMatchObject({
          code: "V1003",
        });
        await expect(
          sibling._execute(sql`INSERT INTO evidence VALUES (3)`)
        ).rejects.toMatchObject({ code: "V1003" });
        await expect(
          sibling.withTransaction(async () => undefined)
        ).rejects.toMatchObject({ code: "V1003" });
      }
      await driver._disconnect();
      if (supplied) {
        expect(transport.closed).toBe(false);
        await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
          code: "V1003",
        });
      } else {
        await driver._executeRaw("INSERT INTO evidence VALUES (3)");
      }
      expect(
        (await holder.execute("SELECT id FROM evidence ORDER BY id")).rows
      ).toEqual(supplied ? [{ id: 1n }] : [{ id: 1n }, { id: 3n }]);
    } finally {
      await driver._disconnect();
      await sibling?._disconnect();
      transport.close();
      held?.close();
      holder.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("local libSQL typed BUSY refuses reuse until its native owner replaces the handle", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-v1-typed-busy-"));
    const url = `file:${join(directory, "evidence.sqlite")}`;
    const transport = createLibSQLTransport({
      url,
      intMode: "bigint",
      timeout: 0,
    });
    const driver = new LibSQLDriver({ client: transport });
    const holder = createLibSQLTransport({
      url,
      intMode: "bigint",
      timeout: 0,
    });
    let held: Awaited<ReturnType<typeof holder.transaction>> | undefined;
    try {
      await driver._executeRaw("CREATE TABLE evidence (id INTEGER)");
      held = await holder.transaction("write");
      await held.execute("INSERT INTO evidence VALUES (1)");
      await expect(
        driver._execute(sql`INSERT INTO evidence VALUES (2)`)
      ).rejects.toThrow();
      await held.commit();
      await expect(
        driver._execute(sql`INSERT INTO evidence VALUES (3)`)
      ).rejects.toMatchObject({ code: "V1003" });
      await driver._disconnect();
      transport.close();
      expect(
        (await holder.execute("SELECT id FROM evidence ORDER BY id")).rows
      ).toEqual([{ id: 1n }]);
    } finally {
      await driver._disconnect();
      transport.close();
      held?.close();
      holder.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses libSQL NUL text before provider truncation", async () => {
    const driver = new LibSQLDriver();
    try {
      await driver._executeRaw("CREATE TABLE evidence (value TEXT)");
      await expect(
        driver._executeRaw("INSERT INTO evidence VALUES (?)", ["before\0after"])
      ).rejects.toThrow();
      expect((await driver._executeRaw("SELECT * FROM evidence")).rows).toEqual(
        []
      );
    } finally {
      await driver._disconnect();
    }
  });

  it("a supplied number-mode libSQL client needs no setup statement and stays exact above 2^53", async () => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-libsql-number-"));
    const file = join(directory, "evidence.sqlite");
    const url = `file:${file}`;
    const account = s.model({
      id: s.bigInt().id(),
      email: s.string(),
      balance: s.decimal({ precision: 18, scale: 0 }),
      score: s.int(),
      active: s.boolean(),
      createdAt: s.dateTime().now(),
      updatedAt: s.dateTime().updatedAt(),
      tags: s.toMany(() => tag),
    });
    const tag = s.model({
      id: s.bigInt().id(),
      label: s.string(),
      accounts: s.toMany(() => account),
    });
    const exact = createLibSQLTransport({ url, intMode: "bigint" });
    const transport = createLibSQLTransport({ url, intMode: "number" });
    const execute = vi.spyOn(transport, "execute");
    const transaction = vi.spyOn(transport, "transaction");
    const client = createClient({
      schema: { account, tag },
      driver: new LibSQLDriver({ client: transport }),
    });
    const big = 9_007_199_254_740_993n;
    const dispatches = async (operation: () => Promise<unknown>) => {
      execute.mockClear();
      transaction.mockClear();
      await operation();
      return {
        statements: execute.mock.calls.map(([statement]) =>
          typeof statement === "string" ? statement : statement.sql
        ),
        transactions: transaction.mock.calls.length,
      };
    };
    const read = () => client.account.findMany({ where: { id: big } });
    try {
      const setup = createClient({
        schema: { account, tag },
        driver: new SQLite3Driver({ dataDir: file }),
      });
      await syncLiveSchema(setup);
      await setup.$disconnect();
      // The first typed operation of a supplied client dispatches exactly what
      // every later one does: no per-client admission round trip.
      const cold = await dispatches(read);
      const created = await client.account.create({
        data: {
          id: big,
          email: "a@example.com",
          balance: "900719925474099301",
          score: 1,
          active: true,
          tags: {
            create: [
              { id: big + 1n, label: "a" },
              { id: big + 2n, label: "b" },
            ],
          },
        },
      });
      expect(await dispatches(read)).toEqual(cold);
      expect(created).toMatchObject({ id: big, score: 1, active: true });
      expect(String(created.balance)).toBe("900719925474099301");
      await client.account.update({
        where: { id: big },
        data: { balance: { increment: "1" } },
      });
      const [found] = await read();
      expect(found?.id).toBe(big);
      expect(String(found?.balance)).toBe("900719925474099302");
      // A nested m2m write reads the junction row it holds; its keys stay exact.
      const relabelled = await client.account.update({
        where: { id: big },
        data: {
          tags: { updateMany: { where: { label: "b" }, data: { label: "B" } } },
        },
        include: { tags: { orderBy: { id: "asc" } } },
      });
      expect(relabelled.tags.map(({ id, label }) => [id, label])).toEqual([
        [big + 1n, "a"],
        [big + 2n, "B"],
      ]);
      const totals = await client.account.aggregate({
        _sum: { balance: true },
        _max: { id: true },
      });
      expect(totals._max.id).toBe(big);
      expect(String(totals._sum.balance)).toBe("900719925474099302");
      expect(
        (await exact.execute("SELECT id, balance FROM account")).rows
      ).toEqual([{ id: big, balance: 900_719_925_474_099_302n }]);
    } finally {
      await client.$disconnect();
      transport.close();
      exact.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("quarantines a shared supplied handle when its first statement is busy", async () => {
    const transport = createLibSQLTransport({
      url: "file::memory:",
      intMode: "bigint",
    });
    const driver = new LibSQLDriver({ client: transport });
    const sibling = new LibSQLDriver({ client: transport });
    const busy = Object.assign(new Error("locked during setup"), {
      code: "SQLITE_BUSY",
    });
    const execute = vi.spyOn(transport, "execute").mockRejectedValueOnce(busy);
    const close = vi.spyOn(transport, "close");
    try {
      await expect(driver._execute(sql`SELECT 1`)).rejects.toMatchObject({
        code: "V5006",
        meta: { providerCode: "SQLITE_BUSY" },
      });
      await expect(sibling._executeRaw("SELECT 1")).rejects.toMatchObject({
        code: "V1003",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      await driver._disconnect();
      expect(close).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
      close.mockRestore();
      await driver._disconnect();
      await sibling._disconnect();
      transport.close();
    }
  });
});
