/**
 * A nested transaction that fails and is never awaited: its failure is the
 * outer transaction's, which rolls back, and it is reported there only. The
 * promise the caller dropped leaves no unhandled rejection behind (in Node
 * that ends the process), with or without an extension that collects what
 * the scopes register. A nested failure the caller observes leaves the outer
 * transaction to commit.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import { around, extension, settled, sql } from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });

interface Loose {
  post: {
    create(args: object): Promise<unknown>;
    findMany(args?: object): Promise<Record<string, unknown>[]>;
  };
  $extends(definition: unknown): Loose;
  $executeRaw(query: unknown): Promise<number>;
  $transaction<T>(fn: (tx: Loose) => Promise<T>): Promise<T>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

const clients = {
  plain: (base: Loose) => ({ db: base, told: [] as string[] }),
  extended: (base: Loose) => {
    const told: string[] = [];
    const db = base.$extends(
      extension(
        "after-raw",
        around((c) => {
          if (c.kind !== "raw") return;
          settled(c, ({ certainty }) => {
            told.push(certainty);
          });
        })
      )
    );
    return { db, told };
  },
} as const;

/** The rejections no handler took while `run` ran, a macrotask included. */
async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
  const unhandled: unknown[] = [];
  const listener = (reason: unknown) => unhandled.push(reason);
  process.on("unhandledRejection", listener);
  try {
    await run();
    await new Promise((resolve) => setTimeout(resolve, 10));
  } finally {
    process.off("unhandledRejection", listener);
  }
  return unhandled;
}

for (const [name, make] of Object.entries(clients))
  describe(`${name}: a nested transaction never awaited`, () => {
    async function open() {
      const base = createClient({
        schema: { post },
        dataDir: ":memory:",
      }) as never as Loose;
      opened.push(base);
      await syncLiveSchema(base as never);
      return { base, ...make(base) };
    }
    const insert = (id: string) =>
      sql`INSERT INTO post (id, title) VALUES (${id}, ${"a"})`;

    test("fails the outer transaction with its failure, and leaves no unhandled rejection", async () => {
      const { base, db, told } = await open();
      const failure = new TypeError("unobserved nested failure");
      let failed: unknown;
      const unhandled = await unhandledDuring(async () => {
        failed = await db
          .$transaction(async (tx) => {
            await tx.$executeRaw(insert("outer"));
            tx.$transaction(async (nested) => {
              await nested.$executeRaw(insert("nested"));
              throw failure;
            });
            await tx.$transaction(async (after) => {
              await after.$executeRaw(insert("after"));
            });
          })
          .catch((error: unknown) => error);
      });
      expect(failed).toBe(failure);
      expect(unhandled).toEqual([]);
      expect(told).toEqual([]);
      expect(await base.post.findMany({})).toEqual([]);
    });

    test("a nested failure the caller observes lets the outer commit, without the savepoint's writes", async () => {
      const { base, db, told } = await open();
      const unhandled = await unhandledDuring(async () => {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw(insert("outer"));
          await tx
            .$transaction(async (nested) => {
              await nested.$executeRaw(insert("nested"));
              throw new TypeError("observed nested failure");
            })
            .catch(() => undefined);
        });
      });
      expect(unhandled).toEqual([]);
      expect((await base.post.findMany({})).map((row) => row.id)).toEqual([
        "outer",
      ]);
      if (name === "extended") expect(told).toEqual(["committed"]);
    });

    test("a savepoint whose body resolved but which fails for a failure it never observed tells nothing of its writes when the caller catches it", async () => {
      const { base, db, told } = await open();
      const unhandled = await unhandledDuring(async () => {
        await db.$transaction(async (tx) => {
          await tx.$executeRaw(insert("outer"));
          const failed = await tx
            .$transaction(async (nested) => {
              await nested.$executeRaw(insert("nested"));
              nested.$transaction(async () => {
                throw new TypeError("deeper unobserved failure");
              });
            })
            .catch((error: unknown) => error);
          expect(failed).toBeInstanceOf(Error);
        });
      });
      expect(unhandled).toEqual([]);
      expect((await base.post.findMany({})).map((row) => row.id)).toEqual([
        "outer",
      ]);
      if (name === "extended") expect(told).toEqual(["committed"]);
    });
  });
