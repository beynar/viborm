/**
 * pg Driver Tests - `settled` across savepoints on a real PostgreSQL server.
 * A nested transaction that fails and is caught rolls back to its savepoint:
 * the outer one commits what it wrote before and after, and what the failed
 * savepoint registered is never told. A nested transaction that fails and is
 * never awaited fails the outer one: nothing commits, nothing is told, and
 * the promise dropped leaves no unhandled rejection. Each
 * holds whether the chain hears writes (`watch`), holds `unit` parts, or only
 * registers a raw statement's `settled`.
 *
 * NOTE: These tests require a running PostgreSQL database.
 */

import { PgDriver } from "@drivers/pg";
import {
  around,
  call,
  extension,
  settled,
  sql,
  target,
  unit,
  watch,
  writes,
} from "@src/index";
import { openOnFixture } from "@tests/contracts/public-client/on-behavior";
import { dropEveryLiveTable, TEST_CONNECTION_STRING } from "./pg-fixtures";

const describeIf = TEST_CONNECTION_STRING ? describe : describe.skip;

type Base = Awaited<ReturnType<typeof openOnFixture>>;

/** A raw statement's `settled`, told as `raw <certainty>`: hears no write. */
const rawSettled = (told: string[]) =>
  around((c) => {
    if (c.kind !== "raw") return;
    settled(c, ({ certainty }) => {
      told.push(`raw ${certainty}`);
    });
  });

/**
 * The chains under test: each tells `settled` as `<what> <certainty>`, where
 * `<what>` is the id a model write names, or `raw`.
 */
const chains = {
  watch: (told: string[]) =>
    call((c) => {
      const id = String((c.args as { where?: { id?: unknown } }).where?.id);
      watch(c, { wants: () => true, rows: () => undefined });
      settled(c, ({ certainty }) => {
        told.push(`${id} ${certainty}`);
      });
    }, target(writes)),
  raw: (told: string[]) => rawSettled(told),
  // A chain that hears no write, with a unit part: what installs the
  // collector at each scope's start.
  unit: (told: string[]) => [unit((_u, next) => next()), rawSettled(told)],
} as const;

const rename = (id: string, name: string) =>
  sql`UPDATE "user" SET "name" = ${name} WHERE "id" = ${id}`;

describeIf("pg Driver: settled across savepoints", () => {
  beforeEach(dropEveryLiveTable);
  afterAll(dropEveryLiveTable);

  const opened: Base[] = [];
  afterEach(async () => {
    for (const base of opened.splice(0)) await base.$disconnect();
  });
  async function open(chain: keyof typeof chains) {
    const base = await openOnFixture(
      new PgDriver({ databaseUrl: TEST_CONNECTION_STRING })
    );
    opened.push(base);
    const told: string[] = [];
    const made = chains[chain](told);
    const parts = Array.isArray(made) ? made : [made];
    // Each chain's parts are typed against the fixture's client.
    const db = base.$extends(extension("tell", ...(parts as never[])));
    const names = async () =>
      (await base.user.findMany({ orderBy: { id: "asc" } })).map(
        (row) => row.name
      );
    return { db, told, names };
  }

  /** One write of the user `id`, as the chain under test hears it. */
  const write = (
    chain: keyof typeof chains,
    tx: any,
    id: string,
    name: string
  ) =>
    chain === "watch"
      ? tx.user.update({ where: { id }, data: { name } })
      : tx.$executeRaw(rename(id, name));

  for (const chain of Object.keys(chains) as (keyof typeof chains)[]) {
    describe(chain, () => {
      test("a nested transaction that fails and is caught: the outer commits what it wrote, the savepoint's settled is dropped", async () => {
        const { db, told, names } = await open(chain);
        await db.$transaction(async (tx: any) => {
          await write(chain, tx, "u1", "Outer");
          await tx
            .$transaction(async (nested: any) => {
              await write(chain, nested, "u2", "Nested");
              throw new TypeError("nested refuses");
            })
            .catch(() => undefined);
          await write(chain, tx, "u2", "After");
        });
        expect(await names()).toEqual(["Outer", "After"]);
        expect(told).toHaveLength(2);
        expect(told.every((line) => line.endsWith(" committed"))).toBe(true);
        if (chain === "watch")
          expect(told).toEqual(["u1 committed", "u2 committed"]);
      });

      test("a statement PostgreSQL refuses inside a caught savepoint leaves the outer transaction usable", async () => {
        const { db, told, names } = await open(chain);
        await db.$transaction(async (tx: any) => {
          await write(chain, tx, "u1", "Outer");
          const failed = await tx
            .$transaction(async (nested: any) => {
              await write(chain, nested, "u2", "Nested");
              // email is unique: u1 already holds it.
              await nested.user.update({
                where: { id: "u2" },
                data: { email: "ada@example.com" },
              });
            })
            .catch((error: unknown) => error);
          expect(failed).toBeInstanceOf(Error);
          await write(chain, tx, "u2", "After");
        });
        expect(await names()).toEqual(["Outer", "After"]);
        expect(told).toHaveLength(2);
        expect(told.every((line) => line.endsWith(" committed"))).toBe(true);
      });

      test("a nested transaction that fails and is never awaited fails the outer: nothing commits, nothing is told", async () => {
        const { db, told, names } = await open(chain);
        const unhandled: unknown[] = [];
        const listener = (reason: unknown) => unhandled.push(reason);
        process.on("unhandledRejection", listener);
        const failed = await db
          .$transaction(async (tx: any) => {
            await write(chain, tx, "u1", "Outer");
            tx.$transaction(async (nested: any) => {
              await write(chain, nested, "u2", "Nested");
              throw new TypeError("unobserved nested failure");
            });
            // The outer body returns: its commit waits for the savepoint.
          })
          .catch((error: unknown) => error);
        await new Promise((resolve) => setTimeout(resolve, 10));
        process.off("unhandledRejection", listener);
        // The dropped promise's failure is the outer's, reported there alone.
        expect(unhandled).toEqual([]);
        // The nested failure, or the driver's own when the outer ended while
        // its savepoint ran: either way the outer transaction fails.
        expect(failed).toBeInstanceOf(Error);
        expect(await names()).toEqual(["Ada", "Bob"]);
        expect(told).toEqual([]);
      });
    });
  }
});
