/**
 * PlanetScale's Neki refuses a statement referencing more than 256 relations
 * (SQLSTATE 54000) and names itself in each connection's startup
 * (`server_version` "18.6 (…) (Neki)"). A PostgreSQL driver given no
 * `relationsPerStatement` takes 256 from that startup where its transport
 * keeps it (node-postgres on a pool it makes, postgres.js), before the first
 * statement is built, and from Neki's refusal elsewhere (Bun SQL, a supplied
 * pool); a stated bound always wins. Live witness:
 * tests/providers/hosted/neki-permissions-app.test.ts.
 */

import { createServer, type Server, type Socket } from "node:net";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { PostgresDriver } from "@drivers/postgres";
import {
  learnRelationLimit,
  learnServerVersion,
} from "@drivers/shared/relation-bound";
import { defineExtension } from "@extensions/definition";
import { s } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

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
 * on a first connection), or, `refusing`, with Neki's refusal. Terminate
 * ends the connection.
 */
function startupServer(serverVersion: string, refusing = false) {
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
    const answer = (type: number) => {
      if (type === 0x58) socket.end();
      else if (refusing && (type === 0x51 || type === 0x53))
        socket.write(refusal);
      else if (type === 0x51) socket.write(empty([]));
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
        socket.write(
          Buffer.concat([
            message("R", int32(0)),
            message(
              "S",
              Buffer.from(`server_version\0${serverVersion}\0`, "utf8")
            ),
            message("K", Buffer.concat([int32(1), int32(2)])),
            message("Z", Buffer.from("I")),
          ])
        );
        return;
      }
      pending = Buffer.concat([pending, data]);
      while (
        pending.length >= 5 &&
        pending.length >= 1 + pending.readInt32BE(1)
      ) {
        answer(pending[0]!);
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
};
const ports = { neki: 0, plain: 0, refusing: 0 };
beforeAll(async () => {
  ports.neki = await servers.neki.listen();
  ports.plain = await servers.plain.listen();
  ports.refusing = await servers.refusing.listen();
});
afterAll(async () => {
  await servers.neki.close();
  await servers.plain.close();
  await servers.refusing.close();
});

const where = (port: number) => ({
  host: "127.0.0.1",
  port,
  user: "u",
  database: "d",
});

describe("a PostgreSQL driver given no relationsPerStatement", () => {
  test.each([
    ["Neki", "neki", 256],
    ["plain PostgreSQL", "plain", undefined],
  ] as const)("node-postgres reads %s from its first connection's startup", async (_name, server, bound) => {
    const driver = new PgDriver({ options: where(ports[server]) });
    expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
    const before = servers[server].connections();
    await driver.serverFacts();
    expect(servers[server].connections()).toBe(before + 1);
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(bound);
    // Read once: nothing more to wait for.
    expect(driver.serverFacts()).toBeUndefined();
    await driver.disconnect();
  });

  test.each([
    ["Neki", "neki", 256],
    ["plain PostgreSQL", "plain", undefined],
  ] as const)("postgres.js reads %s from its first connection's startup", async (_name, server, bound) => {
    const driver = new PostgresDriver({ options: where(ports[server]) });
    const before = servers[server].connections();
    await driver.serverFacts();
    expect(servers[server].connections()).toBe(before + 1);
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(bound);
    expect(driver.serverFacts()).toBeUndefined();
    await driver.disconnect();
  });

  // postgres.js 3.4 never answers a first `reserve()` that fetches no types.
  test("postgres.js without its type fetch reads Neki once a statement connected it", async () => {
    const driver = new PostgresDriver({
      options: { ...where(ports.neki), fetch_types: false },
    });
    await driver.serverFacts();
    expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
    await driver._executeRaw("SELECT 1");
    expect(driver.serverFacts()).toBeUndefined();
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(256);
    await driver.disconnect();
  });

  test("a supplied pool's startup is the caller's: none is opened, Neki's refusal teaches it", async () => {
    const pool = new pg.Pool(where(ports.neki));
    const driver = new PgDriver({ pool });
    const before = servers.neki.connections();
    expect(driver.serverFacts()).toBeUndefined();
    expect(servers.neki.connections()).toBe(before);
    await pool.end();
  });

  test("a pool given its own Client class keeps it: none is opened, Neki's refusal teaches it", async () => {
    const driver = new PgDriver({
      options: { ...where(ports.neki), Client: pg.Client },
    });
    const before = servers.neki.connections();
    expect(driver.serverFacts()).toBeUndefined();
    expect(servers.neki.connections()).toBe(before);
    await driver.disconnect();
  });

  test("a connection that fails leaves the statement to report it, once", async () => {
    const driver = new PgDriver({ options: where(1) });
    await expect(driver.serverFacts()).resolves.toBeUndefined();
    expect(driver.serverFacts()).toBeUndefined();
    expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
    await driver.disconnect();
  });
});

describe("a stated bound wins", () => {
  const drivers = [
    [
      "node-postgres",
      (options: object) =>
        new PgDriver({ options: where(ports.neki), ...options }),
    ],
    [
      "postgres.js",
      (options: object) =>
        new PostgresDriver({ options: where(ports.neki), ...options }),
    ],
  ] as const;
  test.each(
    drivers
  )("%s: relationsPerStatement is never replaced, by the startup or the refusal, and waits for neither", async (_name, createDriver) => {
    const driver = createDriver({ relationsPerStatement: 1000 });
    expect(driver.serverFacts()).toBeUndefined();
    learnServerVersion(driver.adapter, NEKI);
    learnRelationLimit(driver.adapter, REFUSAL);
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(1000);
    await driver.disconnect();
  });

  test.each(
    drivers
  )("%s: sharedRelationBodies: false keeps every statement's form, Neki or not", async (_name, createDriver) => {
    const driver = createDriver({ sharedRelationBodies: false });
    expect(driver.serverFacts()).toBeUndefined();
    learnServerVersion(driver.adapter, NEKI);
    learnRelationLimit(driver.adapter, REFUSAL);
    expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
    await driver.disconnect();
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
  test.each([
    [
      "node-postgres, on a supplied pool",
      () => new PgDriver({ pool: new pg.Pool(where(ports.refusing)) }),
    ],
    [
      "postgres.js",
      () =>
        new PostgresDriver({
          options: { ...where(ports.refusing), fetch_types: false },
        }),
    ],
  ])("teaches %s, whose statement fails", async (_name, createDriver) => {
    const driver = createDriver();
    await driver.serverFacts();
    expect(driver.adapter.capabilities.relationsPerStatement).toBeUndefined();
    await expect(driver._executeRaw("SELECT 1")).rejects.toThrow();
    expect(driver.adapter.capabilities.relationsPerStatement).toBe(256);
    await driver.disconnect();
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

describe("the engine waits for the server before building", () => {
  // A closure stated thrice: in place unbounded, one reaching set past a
  // bound of 1 (tests/contracts/public-client/extension-shared-bodies.core.test.ts).
  const folder = s.model({
    id: s.string().id(),
    owner: s.string(),
    archived: s.boolean(),
    parentId: s.string().nullable(),
    parent: s
      .toOne(() => folder)
      .fields("parentId")
      .references("id"),
    children: s.toMany(() => folder),
  });
  const underAnn = {
    parent: { recurse: { depth: false }, self: true, some: { owner: "ann" } },
  };
  const folders = defineExtension({
    name: "folders",
    rows: {
      control: "scope",
      default: "ann",
      models: {
        folder: {
          ann: {
            root: {
              OR: [
                { AND: [underAnn, { archived: false }] },
                { AND: [underAnn, { archived: true }] },
                { AND: [underAnn, { owner: "cid" }] },
              ],
            },
          },
        },
      },
    },
  });

  /** A driver whose server, read on a later turn, bounds statements to 1. */
  class LateServer extends SqlOnlyDriver {
    #read: Promise<void> | undefined;
    #unread = true;
    constructor() {
      const adapter = new PostgresAdapter();
      adapter.capabilities.sharesRelationBodies = true;
      super(adapter, "postgresql");
    }
    override serverFacts(): Promise<void> | undefined {
      if (!this.#unread) return undefined;
      this.#read ??= new Promise<void>((resolve) =>
        setTimeout(resolve, 5)
      ).then(() => {
        this.adapter.capabilities.relationsPerStatement = 1;
        this.#unread = false;
      });
      return this.#read;
    }
  }
  const inPlace = (statement: string) =>
    statement.split("EXISTS (WITH RECURSIVE").length - 1;
  const governed = () => {
    const statements: string[] = [];
    const db = createClient({ schema: { folder }, driver: new LateServer() })
      .$extends(folders)
      .$extends({
        name: "statements",
        statement(context) {
          statements.push(context.statement.toStatement());
          return context.statement;
        },
      });
    return { db, statements };
  };

  test("an operation", async () => {
    const { db, statements } = governed();
    await db.folder.findMany({ select: { id: true } });
    expect(statements.map(inPlace)).toEqual([0]);
  });

  test("an array transaction, whose members are built before it connects", async () => {
    const { db, statements } = governed();
    await db.$transaction([db.folder.findMany({ select: { id: true } })]);
    expect(
      statements.filter((sql) => sql.includes('"folder"')).map(inPlace)
    ).toEqual([0]);
  });
});
