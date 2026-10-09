import { createClient as createDriverClient } from "@client/client";
import { createClient, PostgresDriver, vibormTypes } from "@drivers/postgres";
import { isRetryableError, VibORMErrorCode } from "@errors";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { wireInvoice } from "@tests/fixtures/pglite-wire-invoice";
import { pgliteWireServer } from "@tests/fixtures/pglite-wire-server";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * postgres.js against a real server that goes away and comes back: PGlite
 * behind the wire bridge, which `stop()`s refusing connections, `start()`s
 * serving the same database again, and kills a session on demand.
 */

const schema = { invoice: wireInvoice };
const SEEDED = 1000;

const database = openTestPGlite();
const server = pgliteWireServer(database);
let port = 0;

beforeAll(async () => {
  await database.waitReady;
  port = await server.start();
  const seeder = connect();
  await syncLiveSchema(seeder);
  await seeder.invoice.createMany({
    data: Array.from({ length: SEEDED }, (_, index) => ({
      customer: `customer-${index % 97}`,
      amountCents: 100 + index,
    })),
  });
  await seeder.$disconnect();
});

afterAll(() => server.stop());

const url = () => `postgres://postgres:postgres@127.0.0.1:${port}/postgres`;

function connect() {
  return createClient({
    schema,
    databaseUrl: url(),
    options: { max: 1, connect_timeout: 2 },
  });
}

describe("postgres.js transaction during a server outage", () => {
  it("a BEGIN that cannot connect is retryable and the same client recovers", async () => {
    const orm = connect();
    await expect(orm.invoice.count()).resolves.toBe(SEEDED);
    await server.stop();
    const callback = vi.fn(async () => "unreachable");
    const failure = await orm.$transaction(callback).catch((e: unknown) => e);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.CONNECTION_FAILED,
    });
    expect(isRetryableError(failure)).toBe(true);
    expect(callback).not.toHaveBeenCalled();

    await server.start(port);
    await expect(orm.invoice.count()).resolves.toBe(SEEDED);
    const settled = await orm.$transaction(async (tx) => {
      const created = await tx.invoice.create({
        data: { customer: "after-outage", amountCents: 4200 },
      });
      const { count } = await tx.invoice.updateMany({
        where: { customer: "customer-0" },
        data: { paid: true, status: "settled" },
      });
      return { created, count };
    });
    expect(settled.count).toBe(Math.ceil(SEEDED / 97));
    expect(settled.created.updatedAt).toBeInstanceOf(Date);
    await expect(
      orm.invoice.count({ where: { status: "settled", paid: true } })
    ).resolves.toBe(settled.count);
    await expect(orm.invoice.count()).resolves.toBe(SEEDED + 1);
    await orm.$disconnect();
  });

  it("a session that dies inside the transaction still quarantines the client", async () => {
    // Supplied, so the test ends it with a bound: postgres.js 3.4.8's own
    // end() never settles after a session died inside begin().
    const sql = postgres(url(), {
      max: 1,
      connect_timeout: 2,
      types: vibormTypes,
    });
    const orm = createDriverClient({
      schema,
      driver: new PostgresDriver({ client: sql }),
    });
    try {
      // The session dies on postgres.js's own ROLLBACK, after the callback
      // wrote through it: its transaction state is unknown to the client.
      server.killSessionOn("rollback");
      const callbackFailure = new Error("callback failed");
      const failure = await orm
        .$transaction(async (tx) => {
          await tx.invoice.create({
            data: { customer: "inside-dead-session", amountCents: 1 },
          });
          throw callbackFailure;
        })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure).toMatchObject({ cause: callbackFailure });

      await expect(orm.invoice.count()).rejects.toMatchObject({
        code: VibORMErrorCode.TRANSACTION_FAILED,
        message:
          'Driver "postgres" is unavailable after transaction cleanup failed.',
      });
      const { rows } = await database.query(
        "SELECT count(*)::int AS total FROM pgjs_wire_invoice WHERE customer = 'inside-dead-session'"
      );
      expect(rows).toEqual([{ total: 0 }]);
    } finally {
      await orm.$disconnect();
      await sql.end({ timeout: 0 });
    }
  });
});
