/**
 * PlanetScale's Neki refuses a statement referencing more than 256 relations
 * (SQLSTATE 54000) and names itself in each connection's startup
 * (`server_version` "18.6 (…) (Neki)"). A PostgreSQL driver given no
 * `relationsPerStatement` reads that startup where its transport keeps it
 * (node-postgres on a pool it makes, postgres.js) as each statement is built:
 * Neki's 256 until a connection said otherwise, so the first statements and a
 * transaction's fit, and nothing waits or connects for it. Elsewhere (Bun SQL,
 * a supplied pool) Neki's refusal teaches it; a stated bound always wins.
 * Live witness: tests/providers/hosted/neki-permissions-app.test.ts.
 */

import { createServer, type Server, type Socket } from "node:net";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { PgDriver } from "@drivers/pg";
import { PostgresDriver } from "@drivers/postgres";
import { learnRelationLimit } from "@drivers/shared/relation-bound";
import { s } from "@schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const MAX_WAIT = /maxWait/;
const NEKI = "18.6 (Debian 18.6-1.pgdg13+2) (Neki)";
const PLAIN = "18.6 (Debian 18.6-1.pgdg13+2)";

const REFUSAL = {
  code: "54000",
  message:
    "the statement references more than 256 relations, the limit for one statement",
};

/** One wire message: its type byte, then its length and body. */
const message = (type: string, body: Buffer) => {
  const head = Buffer.alloc(5);
  head.write(type, 0, "latin1");
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
};
const int32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};

/**
 * A server that connects (trust authentication, the startup's
 * `server_version`, ready) and answers every statement with no rows: a simple
 * query, or an extended one at its Sync (postgres.js fetches its array types
 * on a first connection), or, `refusing`, with Neki's refusal of `SELECT 1`.
 * Its startup answers after `startupDelay` ms. Terminate ends the connection.
 */
function startupServer(
  serverVersion: string,
  refusing = false,
  startupDelay = 0
) {
  const sockets = new Set<Socket>();
  let connections = 0;
  const empty = (complete: Buffer[]) =>
    Buffer.concat([
      ...complete,
      message("C", Buffer.from("SELECT 0\0")),
      message("Z", Buffer.from("I")),
    ]);
  const refusal = Buffer.concat([
    message(
      "E",
      Buffer.from(`SERROR\0C54000\0M${REFUSAL.message}\0\0`, "utf8")
    ),
    message("Z", Buffer.from("I")),
  ]);
  const server: Server = createServer((socket) => {
    sockets.add(socket);
    let started = false;
    let pending = Buffer.alloc(0);
    let refuseNext = false;
    const answer = (type: number, body: Buffer) => {
      // `refusing` refuses the caller's `SELECT 1` only, not a driver's own reads.
      if (refusing && (type === 0x51 || type === 0x50))
        refuseNext ||= body.includes("SELECT 1");
      if (type === 0x58) socket.end();
      else if (refuseNext && (type === 0x51 || type === 0x53)) {
        refuseNext = false;
        socket.write(refusal);
      } else if (type === 0x51) socket.write(empty([]));
      else if (type === 0x53)
        socket.write(
          empty([
            message("1", Buffer.alloc(0)),
            message("2", Buffer.alloc(0)),
            message("n", Buffer.alloc(0)),
          ])
        );
    };
    socket.on("data", (data) => {
      if (!started) {
        // An SSLRequest is refused ("N"); the startup message is answered.
        if (data.length === 8 && data.readInt32BE(4) === 80_877_103) {
          socket.write("N");
          return;
        }
        started = true;
        connections += 1;
        const ready = Buffer.concat([
          message("R", int32(0)),
          message(
            "S",
            Buffer.from(`server_version\0${serverVersion}\0`, "utf8")
          ),
          message("K", Buffer.concat([int32(1), int32(2)])),
          message("Z", Buffer.from("I")),
        ]);
        setTimeout(() => socket.write(ready), startupDelay);
        return;
      }
      pending = Buffer.concat([pending, data]);
      while (
        pending.length >= 5 &&
        pending.length >= 1 + pending.readInt32BE(1)
      ) {
        answer(pending[0]!, pending.subarray(5, 1 + pending.readInt32BE(1)));
        pending = pending.subarray(1 + pending.readInt32BE(1));
      }
    });
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    listen: () =>
      new Promise<number>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : 0);
        });
      }),
    connections: () => connections,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

const servers = {
  neki: startupServer(NEKI),
  plain: startupServer(PLAIN),
  refusing: startupServer(PLAIN, true),
  // Its startup answers late: a connection is opening, unread, for 50 ms.
  slow: startupServer(PLAIN, false, 50),
};
const ports = { neki: 0, plain: 0, refusing: 0, slow: 0 };
beforeAll(async () => {
  ports.neki = await servers.neki.listen();
  ports.plain = await servers.plain.listen();
  ports.refusing = await servers.refusing.listen();
  ports.slow = await servers.slow.listen();
});
afterAll(async () => {
  await servers.neki.close();
  await servers.plain.close();
  await servers.refusing.close();
  await servers.slow.close();
});

const where = (port: number) => ({
  host: "127.0.0.1",
  port,
  user: "u",
  database: "d",
});

const drivers = [
  [
    "node-postgres",
    (port: number, options: object = {}) =>
      new PgDriver({ options: where(port), ...options }),
  ],
  [
    "postgres.js",
    (port: number, options: object = {}) =>
      new PostgresDriver({ options: where(port), ...options }),
  ],
] as const;
const serverKinds = [
  ["Neki", "neki", 256],
  ["plain PostgreSQL", "plain", undefined],
] as const;
const each = drivers.flatMap(([name, create]) =>
  serverKinds.map(
    ([server, key, bound]) => [name, server, create, key, bound] as const
  )
);
const schema = { item: s.model({ id: s.string().id() }) };
/** A client over `driver` recording the bound each statement was built under. */
const recording = (driver: AnyDriver) => {
  const bounds: (number | undefined)[] = [];
  const db = createClient({ schema, driver }).$extends({
    name: "bounds",
    statement(context) {
      bounds.push(driver.adapter.capabilities.relationsPerStatement);
      return context.statement;
    },
  });
  return { db, bounds };
};

describe("a PostgreSQL driver given no relationsPerStatement", () => {
  test.each(
    each
  )("%s on %s: Neki's bound until a connection says its server, then the server's", async (_name, _server, create, key, bound) => {
    const driver = create(ports[key]);
    const before = servers[key].connections();
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(256);
    // Reading it opens nothing.
    expect(servers[key].connections()).toBe(before);
    await driver._executeRaw("SELECT 1");
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(bound);
    await driver.disconnect();
  });

  // The callback's statements are built on the connection its BEGIN opened.
  test.each(
    each
  )("%s on %s: a first callback transaction, and an array nested in it, build with the server's bound", async (_name, _server, create, key, bound) => {
    const driver = create(ports[key]);
    const { db, bounds } = recording(driver);
    await db.$transaction(async (tx) => {
      await tx.item.findMany();
      await tx.$transaction([tx.item.findMany()]);
    });
    expect(bounds).toEqual([bound, bound]);
    await driver.disconnect();
  });

  test.each(
    drivers
  )("%s: neither $transaction([]) nor a call refused before SQL connects", async (_name, create) => {
    const driver = create(ports.neki);
    const db = createClient({ schema, driver });
    const before = servers.neki.connections();
    await expect(db.$transaction([])).resolves.toEqual([]);
    await expect(
      db.item.findMany({ where: { missing: 1 } } as never)
    ).rejects.toThrow();
    expect(servers.neki.connections()).toBe(before);
    await driver.disconnect();
  });

  // The only connection is opening for a transaction that then holds it: a
  // first callback transaction waits no longer than its maxWait, and an array
  // transaction refuses maxWait before it waits for anything.
  test("node-postgres: a first transaction keeps its maxWait while the only connection is held", async () => {
    const driver = new PgDriver({ options: { ...where(ports.slow), max: 1 } });
    const db = createClient({ schema, driver });
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holding = db.$transaction(() => held);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const started = performance.now();
    await expect(
      db.$transaction(() => Promise.resolve(), { maxWait: 10 })
    ).rejects.toThrow(MAX_WAIT);
    expect(performance.now() - started).toBeLessThan(1000);
    await expect(
      db.$transaction([db.item.findMany()], { maxWait: 10 } as never)
    ).rejects.toThrow(MAX_WAIT);
    release();
    await holding;
    await driver.disconnect();
  });

  test.each([
    ["a supplied pool", (pool: pg.Pool) => new PgDriver({ pool })],
    [
      "a pool given its own Client class",
      (pool: pg.Pool) =>
        new PgDriver({ options: { ...pool.options, Client: pg.Client } }),
    ],
  ])("node-postgres on %s reads no startup: unbounded, until Neki's refusal", async (_name, create) => {
    for (const [key, bound] of [
      ["neki", undefined],
      ["refusing", 256],
    ] as const) {
      const pool = new pg.Pool(where(ports[key]));
      const driver = create(pool);
      await driver._executeRaw("SELECT 1").catch(() => undefined);
      expect(driver.adapter.capabilities.relationsPerStatement).toBe(bound);
      await driver.disconnect();
      await pool.end();
    }
  });
});

// A startup that names no Neki (a proxy in between, say) leaves the refusal.
test.each(
  drivers
)("%s on a server whose startup names no Neki learns from its refusal", async (_name, create) => {
  const driver = create(ports.refusing);
  await expect(driver._executeRaw("SELECT 1")).rejects.toThrow();
  expect(driver.adapter.capabilities.relationsPerStatement).toBe(256);
  await driver.disconnect();
});

describe("a stated bound wins", () => {
  test.each(
    drivers
  )("%s: relationsPerStatement is never replaced, by the startup or the refusal", async (_name, create) => {
    for (const key of ["neki", "refusing"] as const) {
      const driver = create(ports[key], { relationsPerStatement: 1000 });
      await driver._executeRaw("SELECT 1").catch(() => undefined);
      expect(driver.adapter.capabilities.relationsPerStatement).toBe(1000);
      await driver.disconnect();
    }
  });

  test.each(
    drivers
  )("%s: sharedRelationBodies: false keeps every statement's form, Neki or not", async (_name, create) => {
    for (const key of ["neki", "refusing"] as const) {
      const driver = create(ports[key], { sharedRelationBodies: false });
      expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
      await driver._executeRaw("SELECT 1").catch(() => undefined);
      expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
      await driver.disconnect();
    }
  });
});

describe("Neki's refusal", () => {
  const shared = () => {
    const adapter = new PostgresAdapter();
    adapter.capabilities.sharesRelationBodies = true;
    return adapter;
  };
  test.each([
    ["node-postgres and postgres.js", REFUSAL, 256],
    [
      "Bun SQL",
      { ...REFUSAL, code: "ERR_POSTGRES_SERVER_ERROR", errno: "54000" },
      256,
    ],
    [
      "PostgreSQL's own 54000",
      { code: "54000", message: "target lists can have at most 1664 entries" },
      undefined,
    ],
    ["another code", { ...REFUSAL, code: "42P01" }, undefined],
  ])("%s", (_name, error, bound) => {
    const adapter = shared();
    learnRelationLimit(adapter, error);
    expect(adapter.capabilities.relationsPerStatement).toBe(bound);
  });
  test("names the limit it refuses past", () => {
    const adapter = shared();
    learnRelationLimit(adapter, {
      ...REFUSAL,
      message: REFUSAL.message.replace("256", "512"),
    });
    expect(adapter.capabilities.relationsPerStatement).toBe(512);
  });
});
