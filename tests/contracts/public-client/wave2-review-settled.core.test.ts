/**
 * Review of the second extension wave (2026-11-14): `settled` registered on a
 * raw write by an `around` with no target, inside a transaction.
 *
 * `main` (`onWriteOutcome` in a `query` handler) and the base of the wave
 * (950dbf2a0) both tell it once, after the outermost commit, whatever else
 * the chain holds. Since 1caaf0a8f the wave refuses it with a `TypeError`
 * unless ANOTHER part of the chain watches writes or is a `unit`: the same
 * extension works or throws depending on what else the client carries.
 *
 * Runs on in-memory SQLite.
 */

import { createClient } from "@drivers/sqlite3";
import { s } from "@schema";
import {
  around,
  call,
  extension,
  methods,
  settled,
  sql,
  target,
  writes,
} from "@src/index";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import { afterEach, describe, expect, test } from "vitest";

const post = s.model({ id: s.string().id(), title: s.string() });
const schema = { post };

type Row = Record<string, unknown>;
interface Loose {
  $record(id: string): Promise<void>;
  post: {
    findMany(args?: object): Promise<Row[]>;
    create(args: object): Promise<Row>;
  };
  $extends(definition: unknown): Loose;
  $executeRaw(query: unknown): Promise<number>;
  $queryRaw(query: unknown): Promise<Row[]>;
  $transaction(
    body: ((tx: Loose) => Promise<unknown>) | readonly unknown[]
  ): Promise<unknown>;
  $disconnect(): Promise<void>;
}

const opened: Loose[] = [];
afterEach(async () => {
  for (const client of opened.splice(0)) await client.$disconnect();
});

/** An extension that hears raw writes, alone or beside a part on writes. */
async function rawListener(beside: boolean) {
  const base = createClient({ schema, dataDir: ":memory:" }) as never as Loose;
  opened.push(base);
  await syncLiveSchema(base as never);
  const events: string[] = [];
  let db = base.$extends(
    extension(
      "after-raw",
      around((c) => {
        if (c.kind !== "raw") return;
        settled(c, ({ certainty }) => {
          events.push(`settled:${certainty}`);
        });
      })
    )
  );
  if (beside)
    db = db.$extends(
      extension(
        "watcher",
        call(() => undefined, target(writes))
      )
    );
  return { base, db, events };
}

describe("settled on a raw write inside a transaction (main: told after the commit)", () => {
  test("callback transaction: told once, after the commit", async () => {
    const { base, db, events } = await rawListener(false);
    await db.$transaction(async (tx) => {
      await tx.$executeRaw(
        sql`INSERT INTO post (id, title) VALUES (${"1"}, ${"a"})`
      );
      events.push("body-end");
    });
    events.push("resolved");
    expect(events).toEqual(["body-end", "settled:committed", "resolved"]);
    expect((await base.post.findMany({})).length).toBe(1);
  });

  test("array transaction: told once, after the commit", async () => {
    const { base, db, events } = await rawListener(false);
    await db.$transaction([
      db.$executeRaw(sql`INSERT INTO post (id, title) VALUES (${"1"}, ${"a"})`),
    ]);
    expect(events).toEqual(["settled:committed"]);
    expect((await base.post.findMany({})).length).toBe(1);
  });

  test("nested callback transaction: told once, after the outermost commit", async () => {
    const { db, events } = await rawListener(false);
    await db.$transaction(async (tx) => {
      await tx.$transaction(async (inner) => {
        await inner.$executeRaw(
          sql`INSERT INTO post (id, title) VALUES (${"1"}, ${"a"})`
        );
      });
      events.push("outer-body-end");
    });
    expect(events).toEqual(["outer-body-end", "settled:committed"]);
  });

  test("the same extension behaves the same with or without another part on writes", async () => {
    const run = async (beside: boolean) => {
      const { db, events } = await rawListener(beside);
      const failure = await db
        .$transaction(async (tx) => {
          await tx.$executeRaw(
            sql`INSERT INTO post (id, title) VALUES (${"1"}, ${"a"})`
          );
        })
        .then(
          () => undefined,
          (error: unknown) => (error as Error).constructor.name
        );
      return { failure, events };
    };
    expect(await run(false)).toEqual(await run(true));
  });

  test("a raw read in a transaction is never refused for what its around registered", async () => {
    const { db, events } = await rawListener(false);
    await db.$transaction(async (tx) => {
      await tx.$queryRaw(sql`SELECT 1 AS one`);
    });
    expect(events).toEqual([]);
  });
});

describe("settled on a method's scope inside a transaction", () => {
  // The refusal (1caaf0a8f) comes when `settled` is called: after whatever
  // the method already wrote. A caller that catches it commits that write,
  // and the function is never told. The base of the wave told it before the
  // commit; `main` has no `settled` on a scope.
  test("a method that writes, then registers settled: told after the commit, or nothing committed", async () => {
    const base = createClient({
      schema,
      dataDir: ":memory:",
    }) as never as Loose;
    opened.push(base);
    await syncLiveSchema(base as never);
    const events: string[] = [];
    const db = base.$extends(
      extension(
        "recorder",
        methods((scope) => ({
          async $record(id: string) {
            await scope.post?.create({ data: { id, title: "r" } });
            await settled(scope, ({ certainty }) => {
              events.push(`settled:${certainty}`);
            });
          },
        }))
      )
    );
    await db.$transaction(async (tx) => {
      await tx.$record("1").catch(() => events.push("refused"));
      events.push("body-end");
    });
    const rows = (await base.post.findMany({})).length;
    // Either the function is told after the commit of the row it covers, or
    // the row is not committed without it.
    expect(
      rows === 0 || events.join(",") === "body-end,settled:committed"
    ).toBe(true);
  });
});
