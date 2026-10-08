import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createClient as createLibSQLTransport } from "@libsql/client";
import { sql } from "@sql";
import { createClient, s } from "@src/index";
import { qualifyRawDateCutoff } from "@tests/fixtures/raw-date-cutoff";
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

  it("refuses supplied libSQL number mode before a typed write commits", async () => {
    const transport = createLibSQLTransport({ url: "file::memory:" });
    const driver = new LibSQLDriver({ client: transport });
    try {
      await driver._executeRaw("CREATE TABLE evidence (id INTEGER)");
      const { sql } = await import("@sql");
      await expect(
        driver._execute(sql`INSERT INTO evidence VALUES (${9007199254740993n})`)
      ).rejects.toMatchObject({ name: "ClientInitializationError" });
      expect((await driver._executeRaw("SELECT * FROM evidence")).rows).toEqual(
        []
      );
    } finally {
      await driver._disconnect();
      transport.close();
    }
  });

  it("quarantines a supplied handle when its integer setup probe is busy", async () => {
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
