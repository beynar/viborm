import { createClient as createDriverClient } from "@client/client";
import { createClient, PostgresDriver, vibormTypes } from "@drivers/postgres";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { wireInvoice } from "@tests/fixtures/pglite-wire-invoice";
import { pgliteWireServer } from "@tests/fixtures/pglite-wire-server";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * VibORM's own `options.prepare` decides postgres.js statement preparation, on
 * the wire, whatever the connection's own option says.
 *
 * Unprepared, the default, is the unnamed statement: two round trips, Parse,
 * Describe, Flush, wait for the parameter types, then Bind, Execute, Sync. It
 * leaves nothing on the server, so a migration that replaces an enum type
 * breaks no running client and each `in`-list length adds no statement.
 * `options: { prepare: true }` parses a statement once per connection, then
 * costs one round trip: Bind, Execute, Sync.
 */

const schema = { invoice: wireInvoice };
const REPEATS = 5;
/** Rows 1..REPEATS hold these amounts; row SEEDED warms each connection. */
const SEEDED = REPEATS + 1;
const AMOUNTS = Array.from({ length: REPEATS }, (_, index) => 100 + index);
const NAMED = /.+/;
const PARSE_OR_FLUSH = /[PH]/;
const UNNAMED = Array.from({ length: REPEATS }, () => ({
  type: "P",
  statement: "",
}));

const database = openTestPGlite();
const server = pgliteWireServer(database);
let url = "";

/** A caller's postgres.js client, with its own `prepare`, under VibORM. */
const supplied = (prepare: boolean, options?: { prepare: boolean }) => {
  const sql = postgres(url, { max: 1, prepare, types: vibormTypes });
  const orm = createDriverClient({
    schema,
    driver: new PostgresDriver({ client: sql, options }),
  });
  return { orm, end: () => sql.end() };
};

const owned = (prepare?: boolean) => {
  const orm = createClient({
    schema,
    databaseUrl: url,
    options: { max: 1, ...(prepare === undefined ? {} : { prepare }) },
  });
  return { orm, end: async () => undefined };
};

beforeAll(async () => {
  await database.waitReady;
  url = `postgres://postgres:postgres@127.0.0.1:${await server.start()}/postgres`;
  const { orm: seeder } = owned();
  await syncLiveSchema(seeder);
  await seeder.invoice.createMany({
    data: Array.from({ length: SEEDED }, (_, index) => ({
      customer: `customer-${index % 3}`,
      amountCents: 100 + index,
    })),
  });
  await seeder.$disconnect();
});

afterAll(() => server.stop());

/** The messages clients send while `run` executes. */
async function sent(run: () => Promise<unknown>) {
  const from = server.frontend.length;
  await run();
  return server.frontend.slice(from);
}

const types = (messages: readonly { type: string }[]) =>
  messages.map(({ type }) => type).join("");

const parses = (messages: readonly { type: string }[]) =>
  messages.filter(({ type }) => type === "P");

/** `REPEATS` primary-key reads after a first one: what they sent and read. */
async function repeatedReads(
  findUnique: (id: number) => Promise<{ amountCents: number } | null>
) {
  await findUnique(SEEDED);
  const amounts: (number | undefined)[] = [];
  const messages = await sent(async () => {
    for (let id = 1; id <= REPEATS; id++) {
      amounts.push((await findUnique(id))?.amountCents);
    }
  });
  return { amounts, messages };
}

type Orm = ReturnType<typeof owned>["orm"];

const typedReads = (orm: Orm) =>
  repeatedReads((id) => orm.invoice.findUnique({ where: { id } }));

const rawReads = (orm: Orm) =>
  repeatedReads(
    async (id) =>
      (
        await orm.$queryRawUnsafe<{ amountCents: number }>(
          'SELECT "amountCents" FROM "pgjs_wire_invoice" WHERE "id" = $1',
          id
        )
      )[0] ?? null
  );

describe("postgres.js statement preparation", () => {
  it.each([
    ["an owned client", () => owned()],
    ["a supplied prepare:true client", () => supplied(true)],
    ["a supplied prepare:false client", () => supplied(false)],
  ])("%s sends the unnamed statement by default, typed and raw", async (_, connect) => {
    const { orm, end } = connect();
    try {
      for (const reads of [await typedReads(orm), await rawReads(orm)]) {
        expect(reads.amounts).toEqual(AMOUNTS);
        expect(types(reads.messages)).toBe("PDHBES".repeat(REPEATS));
        expect(parses(reads.messages)).toEqual(UNNAMED);
      }
    } finally {
      await orm.$disconnect();
      await end();
    }
  });

  it.each([
    ["an owned client", () => owned(true)],
    ["a supplied client", () => supplied(true, { prepare: true })],
  ])("options.prepare: true makes %s parse a statement once, then only bind and execute it", async (_, connect) => {
    const { orm, end } = connect();
    const settle = (id: number) =>
      orm.invoice.update({
        where: { id },
        data: { paid: true, status: "settled" },
      });
    try {
      await orm.invoice.count();
      const first = await sent(() =>
        orm.invoice.findUnique({ where: { id: SEEDED } })
      );
      expect(first).toEqual([
        { type: "P", statement: expect.stringMatching(NAMED) },
        { type: "D" },
        { type: "H" },
        { type: "B" },
        { type: "E" },
        { type: "S" },
      ]);
      for (const reads of [await typedReads(orm), await rawReads(orm)]) {
        expect(reads.amounts).toEqual(AMOUNTS);
        expect(types(reads.messages)).toBe("BES".repeat(REPEATS));
      }

      await settle(1);
      const updates = await sent(async () => {
        for (let id = 2; id <= REPEATS; id++) {
          await expect(settle(id)).resolves.toMatchObject({
            id,
            paid: true,
            status: "settled",
          });
        }
      });
      expect(types(updates)).not.toMatch(PARSE_OR_FLUSH);

      // A transaction runs on the same connection: once the first one has
      // prepared postgres.js's own COMMIT, nothing is parsed again.
      const transaction = () =>
        orm.$transaction(async (tx) => {
          await tx.invoice.findUnique({ where: { id: 1 } });
          return tx.invoice.update({
            where: { id: 1 },
            data: { paid: true, status: "settled" },
          });
        });
      await transaction();
      expect(types(await sent(transaction))).not.toMatch(PARSE_OR_FLUSH);
      await expect(
        orm.invoice.count({ where: { status: "settled", paid: true } })
      ).resolves.toBe(REPEATS);
    } finally {
      await orm.$disconnect();
      await end();
    }
  });
});
