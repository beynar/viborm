import { once } from "node:events";
import { createServer, type Server, type Socket } from "node:net";
import { createClient as createDriverClient } from "@client/client";
import { createClient, PostgresDriver, vibormTypes } from "@drivers/postgres";
import type { PGlite } from "@electric-sql/pglite";
import { isRetryableError, VibORMErrorCode } from "@errors";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { syncLiveSchema } from "@tests/fixtures/sync-schema";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/**
 * postgres.js against a real server that goes away and comes back.
 *
 * The server is PGlite behind a minimal PostgreSQL wire bridge on a fixed
 * loopback port: `stop()` refuses every connection the way a restarting server
 * does, `start()` serves the same database again, and `killSessionOn(text)`
 * kills the session that sends `text` before answering it. One connection at a
 * time (`max: 1`), because PGlite is a single session.
 */
const STARTUP_PROTOCOL = 196_608;

function wireServer(database: PGlite) {
  const sockets = new Set<Socket>();
  // PGlite is one session, so every connection's messages share one queue.
  let replies = Promise.resolve();
  let server: Server | undefined;
  let fatal: string | undefined;
  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => undefined);
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const startup =
          pending.length >= 8 && pending.readInt32BE(4) === STARTUP_PROTOCOL;
        const length = startup
          ? pending.readInt32BE(0)
          : pending.length >= 5
            ? pending.readInt32BE(1) + 1
            : Number.POSITIVE_INFINITY;
        if (pending.length < length) return;
        const message = pending.subarray(0, length);
        pending = pending.subarray(length);
        if (fatal && message.includes(fatal)) {
          // PostgreSQL ends a dead session's transaction.
          replies = replies.then(async () => {
            await database.exec("ROLLBACK");
          });
          socket.destroy();
          return;
        }
        replies = replies.then(async () => {
          const reply = await database.execProtocolRaw(message);
          if (!socket.destroyed) socket.write(reply);
        });
      }
    });
  };
  return {
    start: (port = 0) =>
      new Promise<number>((resolve) => {
        const listening = createServer(serve);
        server = listening;
        listening.listen(port, "127.0.0.1", () => {
          const address = listening.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      }),
    stop: async () => {
      await Promise.all([
        ...[...sockets].map((socket) => once(socket.destroy(), "close")),
        new Promise((resolve) => server?.close(resolve)),
      ]);
      await replies;
    },
    killSessionOn: (text: string) => {
      fatal = text;
    },
  };
}

const invoice = s
  .model({
    id: s.string().id().ulid(),
    customer: s.string(),
    amountCents: s.int(),
    status: s.string().default("open"),
    paid: s.boolean().default(false),
    createdAt: s.dateTime().now(),
    updatedAt: s.dateTime().updatedAt(),
  })
  .map("pgjs_outage_invoice");
const schema = { invoice };
const SEEDED = 10_000;
/** One 5,000-row Bind stalls this minimal bridge; 2,000-row chunks do not. */
const SEED_CHUNK = 2000;

const database = openTestPGlite();
const server = wireServer(database);
let port = 0;

beforeAll(async () => {
  await database.waitReady;
  port = await server.start();
  const seeder = connect();
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
        "SELECT count(*)::int AS total FROM pgjs_outage_invoice WHERE customer = 'inside-dead-session'"
      );
      expect(rows).toEqual([{ total: 0 }]);
    } finally {
      await orm.$disconnect();
      await sql.end({ timeout: 0 });
    }
  });
});
