/**
 * A local libSQL BUSY while opening a transaction must not leave writes that
 * are acknowledged and then lost.
 *
 * libSQL's native statement that fails with BUSY stays unfinished on the
 * pooled connection, so SQLite never commits that connection's later
 * autocommit writes: they are read back by the same client and discarded at
 * close. Another process holds the write lock past the busy timeout while the
 * client opens a `$transaction` or a nested create (an implicit transaction).
 * Every write the client acknowledges must be visible to a third connection,
 * and the failed client must refuse further work instead of acknowledging it.
 */

import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VibORMClient, VibORMConfig } from "@client/client";
import { LibSQLDriver } from "@drivers/libsql";
import { SQLite3Driver } from "@drivers/sqlite3";
import { createClient as createLibSQLTransport } from "@libsql/client";
import { createClient, s } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

const author = s.model({
  id: s.int().id(),
  name: s.string(),
  email: s.string().unique(),
  bio: s.string().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
  books: s.toMany(() => book),
});
const book = s.model({
  id: s.int().id(),
  title: s.string(),
  pages: s.int(),
  authorId: s.int(),
  author: s
    .toOne(() => author)
    .fields("authorId")
    .references("id"),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const schema = { author, book };

const SEEDED = 1000;
// Long enough that a write issued while the holder rolls back waits for it.
const BUSY_TIMEOUT_MS = 250;

// Holds BEGIN IMMEDIATE in another process until its stdin closes.
const HOLDER = `const D=require(process.argv[1]);const d=new D(process.argv[2]);d.exec("BEGIN IMMEDIATE");process.stdout.write("locked\\n");process.stdin.on("end",()=>{d.exec("ROLLBACK");d.close()}).resume();`;
const betterSqlite3 = createRequire(import.meta.url).resolve("better-sqlite3");

async function holdWriteLock(file: string) {
  const holder = spawn(process.execPath, ["-e", HOLDER, betterSqlite3, file], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  const exited = once(holder, "exit");
  await once(holder.stdout, "data");
  // Resolves once stdin is closed; the holder then rolls back.
  const release = () =>
    new Promise<void>((resolve) => holder.stdin.end(() => resolve()));
  return { release, exited };
}

function durableIds(file: string, table: string): number[] {
  const observer = new Database(file, { readonly: true });
  try {
    return observer
      .prepare<[], { id: number }>(`SELECT id FROM "${table}" ORDER BY id`)
      .all()
      .map(({ id }) => id);
  } finally {
    observer.close();
  }
}

const authorData = (id: number) => ({
  id,
  name: `Author ${id}`,
  email: `author-${id}@example.test`,
  bio: id % 2 === 0 ? null : `Bio ${id}`,
});

type Client = VibORMClient<VibORMConfig<typeof schema>>;
const busyWrites: Record<string, (client: Client) => Promise<unknown>> = {
  $transaction: (client) =>
    client.$transaction(async (tx) => {
      await tx.author.create({ data: authorData(SEEDED + 1) });
      return tx.book.create({
        data: { id: 1, title: "Locked", pages: 120, authorId: SEEDED + 1 },
      });
    }),
  "nested create": (client) =>
    client.author.create({
      data: {
        ...authorData(SEEDED + 1),
        books: { create: [{ id: 1, title: "Locked", pages: 120 }] },
      },
    }),
};

describe("local libSQL BUSY while opening a transaction", () => {
  it.each(
    Object.keys(busyWrites).flatMap((write) =>
      [false, true].map((supplied) => ({ write, supplied }))
    )
  )("$write never acknowledges a lost write (supplied=$supplied)", async ({
    write,
    supplied,
  }) => {
    const directory = mkdtempSync(join(tmpdir(), "viborm-libsql-busy-tx-"));
    const file = join(directory, "library.sqlite");
    const url = `file:${file}`;
    const setup = createClient({
      schema,
      driver: new SQLite3Driver({ dataDir: file }),
    });
    await syncLiveSchema(setup);
    await setup.$disconnect();

    const transport = supplied
      ? createLibSQLTransport({
          url,
          intMode: "bigint",
          timeout: BUSY_TIMEOUT_MS,
        })
      : undefined;
    let client: Client = createClient({
      schema,
      driver: new LibSQLDriver(
        transport
          ? { client: transport }
          : { databaseUrl: url, options: { timeout: BUSY_TIMEOUT_MS } }
      ),
    });
    let holder: Awaited<ReturnType<typeof holdWriteLock>> | undefined;
    let replacement: ReturnType<typeof createLibSQLTransport> | undefined;
    const seeded = Array.from({ length: SEEDED }, (_, index) => index + 1);
    try {
      await client.author.createMany({ data: seeded.map(authorData) });
      expect(durableIds(file, "author")).toEqual(seeded);

      holder = await holdWriteLock(file);
      await expect(busyWrites[write]?.(client)).rejects.toMatchObject({
        code: "V5006",
        meta: { providerCode: "SQLITE_BUSY" },
      });
      // One typed write races the holder's rollback; a typed and a raw write
      // follow it. None may be acknowledged on the failed connection, where
      // SQLite would never commit it.
      const acknowledged = [...seeded];
      const attempt = (id: number, write: Promise<unknown>) =>
        write.then(
          () => {
            acknowledged.push(id);
            return "acknowledged";
          },
          (error: { code?: string }) => error.code
        );
      const typed = (id: number) =>
        attempt(id, client.author.create({ data: authorData(id) }));
      await holder.release();
      const racing = await typed(SEEDED + 2);
      await holder.exited;
      const following = await typed(SEEDED + 3);
      const raw = await attempt(
        SEEDED + 4,
        client.$executeRaw`INSERT INTO "author" ("id", "name", "email", "createdAt", "updatedAt") SELECT ${SEEDED + 4}, 'Raw', 'raw@example.test', "createdAt", "updatedAt" FROM "author" WHERE "id" = 1`
      );
      expect(durableIds(file, "author")).toEqual(acknowledged);
      expect([racing, following, raw]).toEqual(["V1003", "V1003", "V1003"]);
      await expect(
        client.$transaction(async (tx) => tx.author.count())
      ).rejects.toMatchObject({ code: "V1003" });
      expect(durableIds(file, "book")).toEqual([]);

      await client.$disconnect();
      if (transport) {
        // A borrowed client stays refused: only its owner can replace it.
        expect(transport.closed).toBe(false);
        await expect(client.author.count()).rejects.toMatchObject({
          code: "V1003",
        });
        transport.close();
        replacement = createLibSQLTransport({ url, intMode: "bigint" });
        client = createClient({
          schema,
          driver: new LibSQLDriver({ client: replacement }),
        });
      }
      const recovered = await client.author.create({
        data: authorData(SEEDED + 5),
      });
      expect(recovered.createdAt).toBeInstanceOf(Date);
      expect(durableIds(file, "author")).toEqual([...seeded, SEEDED + 5]);
    } finally {
      await holder?.release();
      await client.$disconnect();
      transport?.close();
      replacement?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
