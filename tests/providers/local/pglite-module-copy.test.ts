/**
 * platform-10: a PGlite built by another copy of `@electric-sql/pglite` (here
 * its CommonJS build, whose class is not the ESM class VibORM imports) is a
 * PGlite all the same. The driver used to test `instanceof PGlite` to tell the
 * database from a transaction handle, so such a database failed every
 * transaction and every pinned migration command with "nested provider state
 * outside TransactionBoundDriver".
 *
 * Also the pglite half of platform-16: an unknown wrapper key is refused.
 */

import { createRequire } from "node:module";
import { createClient, PGliteDriver } from "@drivers/pglite";
import { PGlite as EsmPGlite, type Transaction } from "@electric-sql/pglite";
import { ClientInitializationError } from "@errors";
import { createMigrationClient } from "@migrations";
import { s } from "@schema";
import { afterAll, expect, it } from "vitest";

const { PGlite: CjsPGlite } = createRequire(import.meta.url)(
  "@electric-sql/pglite"
) as { PGlite: typeof EsmPGlite };

const account = s
  .model({
    id: s.int().id(),
    email: s.string().unique(),
    name: s.string(),
    handle: s.string(),
    bio: s.string().nullable(),
    plan: s.string(),
    seats: s.int(),
    credits: s.int(),
    score: s.number(),
    active: s.boolean(),
    verified: s.boolean(),
    locale: s.string(),
    timezone: s.string(),
    createdAt: s.dateTime(),
    updatedAt: s.dateTime(),
  })
  .map("copy_accounts");

const supplied = new CjsPGlite();
afterAll(() => supplied.close());

it("runs push, transactions and writes on a PGlite from another module copy", async () => {
  expect(CjsPGlite).not.toBe(EsmPGlite);
  const db = createClient({ schema: { account }, client: supplied });
  try {
    await createMigrationClient(db).push();
    const row = (id: number) => ({
      id,
      email: `user${id}@example.com`,
      name: `User ${id}`,
      handle: `user${id}`,
      bio: null,
      plan: "team",
      seats: 3,
      credits: id,
      score: id / 2,
      active: true,
      verified: id % 2 === 0,
      locale: "en",
      timezone: "UTC",
      createdAt: new Date(0),
      updatedAt: new Date(0),
    });
    await db.$transaction(async (tx) => {
      await tx.account.create({ data: row(1) });
    });
    await db.account.create({ data: row(2) });
    await db.account.createMany({
      data: Array.from({ length: 98 }, (_, index) => row(index + 3)),
    });
    expect(await db.account.count()).toBe(100);
  } finally {
    await db.$disconnect();
  }
});

class TransactionProbe extends PGliteDriver {
  runOn(handle: Transaction) {
    return this.transaction(handle, async () => undefined);
  }
}

it("still refuses a transaction handle where the database belongs", async () => {
  const probe = new TransactionProbe({ client: supplied });
  await supplied.transaction(async (tx) => {
    expect(() => probe.runOn(tx)).toThrow(
      'Driver "pglite" received nested provider state outside TransactionBoundDriver.'
    );
  });
});

it("refuses a key viborm/pglite does not read", () => {
  const attempt = () =>
    createClient({
      schema: { account },
      // @ts-expect-error -- not a viborm/pglite option
      databaseUrl: "postgres://localhost/db",
    });
  expect(attempt).toThrow(ClientInitializationError);
  expect(attempt).toThrow(
    'viborm/pglite does not accept "databaseUrl"; it accepts schema, skipSchemaValidation, client, dataDir, options, pgvector, postgis, namespace.'
  );
});
