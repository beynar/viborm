import { createClient as createDriverClient } from "@client/client";
import { createClient, PostgresDriver, vibormTypes } from "@drivers/postgres";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { pgliteWireServer } from "@tests/fixtures/pglite-wire-server";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The postgres.js connection's own `prepare` option decides, on the wire.
 *
 * An unprepared parameterized statement is two round trips — Parse, Describe,
 * Flush, wait for the parameter types, then Bind, Execute, Sync. A prepared
 * one is parsed once per connection and then costs one: Bind, Execute, Sync.
 */

const invoice = s
  .model({
    id: s.int().id().increment(),
    customer: s.string(),
    amountCents: s.int(),
    status: s.string().default("open"),
    paid: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("pgjs_prepare_invoice");
const schema = { invoice };
const SEEDED = 10_000;
/** One 5,000-row Bind stalls this minimal bridge; 2,000-row chunks do not. */
const SEED_CHUNK = 2000;
const REPEATS = 5;
/** Rows 1..REPEATS were seeded with these amounts. */
const AMOUNTS = Array.from({ length: REPEATS }, (_, index) => 100 + index);
const NAMED = /.+/;
const PARSE_OR_FLUSH = /[PH]/;

const database = openTestPGlite();
const server = pgliteWireServer(database);
let url = "";

const supplied = (prepare: boolean) => {
  const sql = postgres(url, { max: 1, prepare, types: vibormTypes });
  const orm = createDriverClient({
    schema,
    driver: new PostgresDriver({ client: sql }),
  });
  return { orm, sql };
};

beforeAll(async () => {
  await database.waitReady;
  url = `postgres://postgres:postgres@127.0.0.1:${await server.start()}/postgres`;
  // Seeded through a prepared connection: 2,000-row binds on named statements.
  const { orm: seeder, sql } = supplied(true);
  await syncLiveSchema(seeder);
  for (let first = 0; first < SEEDED; first += SEED_CHUNK) {
    await seeder.invoice.createMany({
      data: Array.from({ length: SEED_CHUNK }, (_, offset) => ({
        customer: `customer-${(first + offset) % 97}`,
        amountCents: 100 + first + offset,
      })),
    });
  }
  await seeder.$disconnect();
  await sql.end();
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

describe("postgres.js statement preparation", () => {
  it("a supplied prepare:true client parses a statement once, then only binds and executes it", async () => {
    const { orm, sql } = supplied(true);
    const findUnique = (id: number) =>
      orm.invoice.findUnique({ where: { id } });
    const settle = (id: number) =>
      orm.invoice.update({
        where: { id },
        data: { paid: true, status: "settled" },
      });
    try {
      await orm.invoice.count();
      const first = await sent(() => findUnique(SEEDED));
      expect(first).toEqual([
        { type: "P", statement: expect.stringMatching(NAMED) },
        { type: "D" },
        { type: "H" },
        { type: "B" },
        { type: "E" },
        { type: "S" },
      ]);
      const reads = await repeatedReads(findUnique);
      expect(reads.amounts).toEqual(AMOUNTS);
      expect(types(reads.messages)).toBe("BES".repeat(REPEATS));

      const raw = await repeatedReads(
        async (id) =>
          (
            await orm.$queryRawUnsafe<{ amountCents: number }>(
              'SELECT "amountCents" FROM "pgjs_prepare_invoice" WHERE "id" = $1',
              id
            )
          )[0] ?? null
      );
      expect(raw.amounts).toEqual(AMOUNTS);
      expect(types(raw.messages)).toBe("BES".repeat(REPEATS));

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
      await sql.end();
    }
  });

  it("an owned client with default options keeps the unnamed statement", async () => {
    const orm = createClient({ schema, databaseUrl: url, options: { max: 1 } });
    try {
      const reads = await repeatedReads((id) =>
        orm.invoice.findUnique({ where: { id } })
      );
      expect(reads.amounts).toEqual(AMOUNTS);
      expect(types(reads.messages)).toBe("PDHBES".repeat(REPEATS));
      expect(reads.messages.filter(({ type }) => type === "P")).toEqual(
        Array.from({ length: REPEATS }, () => ({ type: "P", statement: "" }))
      );
    } finally {
      await orm.$disconnect();
    }
  });

  it("a supplied prepare:false client keeps the unnamed statement", async () => {
    const { orm, sql } = supplied(false);
    try {
      const reads = await repeatedReads((id) =>
        orm.invoice.findUnique({ where: { id } })
      );
      expect(reads.amounts).toEqual(AMOUNTS);
      expect(types(reads.messages)).toBe("PDHBES".repeat(REPEATS));
    } finally {
      await orm.$disconnect();
      await sql.end();
    }
  });

  it("an owned client opts in with options.prepare", async () => {
    const orm = createClient({
      schema,
      databaseUrl: url,
      options: { max: 1, prepare: true },
    });
    try {
      const reads = await repeatedReads((id) =>
        orm.invoice.findUnique({ where: { id } })
      );
      expect(reads.amounts).toEqual(AMOUNTS);
      expect(types(reads.messages)).toBe("BES".repeat(REPEATS));
    } finally {
      await orm.$disconnect();
    }
  });
});
