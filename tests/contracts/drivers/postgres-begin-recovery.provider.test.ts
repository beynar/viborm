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
 * does, and `start()` serves the same database again. One connection at a time
 * (`max: 1`), because PGlite is a single session.
 */
const STARTUP_PROTOCOL = 196_608;

function wireServer(database: PGlite) {
  const sockets = new Set<Socket>();
  const closing: Promise<void>[] = [];
  let server: Server | undefined;
  const serve = (socket: Socket) => {
    sockets.add(socket);
    let pending = Buffer.alloc(0);
    let replies = Promise.resolve();
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
        replies = replies.then(async () => {
          const reply = await database.execProtocolRaw(message);
          if (!socket.destroyed) socket.write(reply);
        });
      }
    });
    // The server ends a dead session's transaction, exactly as PostgreSQL does.
    socket.on("close", () => {
      sockets.delete(socket);
      closing.push(
        replies.then(async () => {
          if (database.isInTransaction()) await database.exec("ROLLBACK");
        })
      );
    });
    socket.on("error", () => undefined);
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
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server?.close(resolve));
      await Promise.all(closing);
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
    try {
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
    } finally {
      await orm.invoice.deleteMany({ where: { customer: "after-outage" } });
      await orm.invoice.updateMany({
        where: { customer: "customer-0" },
        data: { paid: false, status: "open" },
      });
      await orm.$disconnect();
    }
  });

  it("an outage after the transaction holds a session still quarantines the client", async () => {
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
      const failure = await orm
        .$transaction(async (tx) => {
          await tx.invoice.create({
            data: { customer: "inside-dead-session", amountCents: 1 },
          });
          await server.stop();
          return await tx.invoice.count();
        })
        .catch((e: unknown) => e);
      expect(failure).toBeInstanceOf(Error);

      await server.start(port);
      await expect(orm.invoice.count()).rejects.toMatchObject({
        code: VibORMErrorCode.TRANSACTION_FAILED,
        message:
          'Driver "postgres" is unavailable after transaction cleanup failed.',
      });
      const rows = await sql`
        SELECT count(*)::int AS total FROM pgjs_outage_invoice
        WHERE customer = 'inside-dead-session'`;
      expect(rows).toEqual([{ total: 0 }]);
    } finally {
      await orm.$disconnect();
      await sql.end({ timeout: 0 });
    }
  });
});
