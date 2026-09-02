/**
 * Who owns the transport, decided ONCE, when the driver is built.
 *
 * `pg` and MySQL2 accept a caller's pool and create one otherwise, and both
 * used to answer "is this pool mine?" by reading the caller's options object at
 * the moment they were about to close it. That object belongs to the caller:
 * deleting `pool` from it after construction made VibORM end a pool it was
 * handed and may be shared with the caller's own code, and adding one made
 * VibORM keep a pool it created open forever. The same late read decided what
 * to CONNECT with, so a record mutated after construction pointed the next pool
 * somewhere the resolved target never saw.
 *
 * Even with no mutation at all there was a leak: disconnect cleared the
 * captured supplied pool, reconnect created a driver-owned one in its place,
 * and the ownership question — still answered from the options object — said
 * "supplied", so that owned pool was never ended.
 *
 * postgres.js, Bun SQL and PGlite take the same fact under the name `client`,
 * and read it THREE times — once to answer ownership, twice to install it —
 * and PGlite a fourth time to answer whether its results may be consumed. A
 * getter that answers differently each time therefore made one driver hold a
 * transport whose owner it had already decided wrongly. The same three answer
 * for the shared shape the namespace work documents — two schema-scoped estates
 * over one supplied transport — where closing that transport on one wrapper's
 * `$disconnect()` takes the sibling's database with it, and reconnecting builds
 * a DIFFERENT one behind the caller's back.
 *
 * The same identity answers who may SUBSCRIBE to a transport. `pg` reports an
 * idle client's death by emitting 'error' on the pool, which an `EventEmitter`
 * with no subscriber throws into the event loop — from a socket callback, so no
 * request promise is on that stack and the process dies. One listener on the
 * pool this driver made closes that; none on a pool it was handed, because
 * subscribing there is what STOPS a caller's own crash from happening, on a
 * transport they may be sharing with code that meant to hear it.
 */

import { BunSQLDriver } from "@drivers/bun-sql";
import { MySQL2Driver, type MySQL2DriverOptions } from "@drivers/mysql2";
import { PgDriver, type PgDriverOptions } from "@drivers/pg";
import { PGliteDriver } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import { readSuppressedFailures } from "@drivers/shared";
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "@sql";
import type { PoolOptions } from "mysql2/promise";
import { Pool, type PoolConfig } from "pg";
import { describe, expect, it, vi } from "vitest";

// The ownership contract needs constructor-option capture and EventEmitter
// semantics, not node-postgres sockets. PgDriver sees this socket-free class as
// its provider Pool, so its real initialization and cleanup paths still run.
vi.mock("pg", async () => {
  const { EventEmitter } = await import("node:events");

  class SocketFreePool extends EventEmitter {
    readonly options: Record<string, unknown>;

    constructor(options: Record<string, unknown> = {}) {
      super();
      this.options = options;
    }

    end(): Promise<void> {
      return Promise.resolve();
    }

    query(): Promise<never> {
      return Promise.reject(new Error("not used"));
    }

    connect(): Promise<never> {
      return Promise.reject(new Error("not used"));
    }
  }

  return {
    Pool: SocketFreePool,
    types: {
      getTypeParser: () => (value: string) => value,
    },
  };
});

// MySQL2 pools are lazy, but they are still provider-owned handles. This
// stand-in retains the option snapshot shape inspected below and nothing else.
vi.mock("mysql2/promise", () => ({
  createPool: (options: unknown) => ({
    end: () => Promise.resolve(),
    execute: () => Promise.reject(new Error("not used")),
    getConnection: () => Promise.reject(new Error("not used")),
    pool: {
      config: {
        connectionConfig:
          options !== null && typeof options === "object" ? options : {},
      },
    },
    query: () => Promise.reject(new Error("not used")),
  }),
}));

/** One nested value from a provider object, trusting no step of the path. */
function readPath(root: unknown, ...keys: readonly string[]): unknown {
  let value: unknown = root;
  for (const key of keys) {
    if (value === null || typeof value !== "object") {
      return undefined;
    }
    value = Reflect.get(value, key);
  }
  return value;
}

/** A caller's pg pool: it answers nothing, and counts what VibORM does to it. */
function suppliedPgPool() {
  const state = { ended: 0, subscribed: 0, unsubscribed: 0 };
  const pool = Object.create(Pool.prototype);
  Object.defineProperties(pool, {
    end: {
      value: () => {
        state.ended += 1;
        return Promise.resolve();
      },
    },
    query: { value: () => Promise.reject(new Error("not used")) },
    connect: { value: () => Promise.reject(new Error("not used")) },
    on: {
      value: () => {
        state.subscribed += 1;
        return pool;
      },
    },
    off: {
      value: () => {
        state.unsubscribed += 1;
        return pool;
      },
    },
  });
  return { state, pool };
}

/** The socket-free pool a pg driver built for itself, refusing anything else. */
function createdPgPool(driver: PgDriver): Pool {
  const client = Reflect.get(driver, "client");
  if (client instanceof Pool) return client;
  throw new Error("this driver has not created a pool");
}

/** The same for MySQL2. */
function suppliedMySQLPool() {
  const state = { ended: 0 };
  const pool = {
    end: () => {
      state.ended += 1;
      return Promise.resolve();
    },
    getConnection: () => Promise.reject(new Error("not used")),
    query: () => Promise.reject(new Error("not used")),
    execute: () => Promise.reject(new Error("not used")),
  };
  return { state, pool };
}

/** Counts `end()` on the pool a driver just created, and returns it. */
function countEnds(pool: unknown, ended: unknown[]): unknown {
  if (pool !== null && typeof pool === "object") {
    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => {
        ended.push(pool);
        return Promise.resolve();
      },
    });
  }
  return pool;
}

/**
 * The three drivers whose caller-supplied transport arrives as `client`.
 *
 * They differ only in how a transport is closed and how a statement is issued,
 * and the stand-in below answers all three shapes, so the ownership contract is
 * written once and read by each of them.
 */
interface TransportOwner {
  _connect(): Promise<void>;
  _disconnect(): Promise<void>;
  _executeRaw(sql: string): Promise<{ rows: unknown[] }>;
  /** The handle is never used here: these arms only reach the close path. */
  _transaction(fn: () => Promise<unknown>): Promise<unknown>;
}

interface SuppliedClientDriver {
  readonly name: string;
  readonly build: (options: object) => TransportOwner;
  /** The provider's own shape, where its dispatch tests for one. */
  readonly shape: (transport: object) => object;
  /**
   * Breaks the transport's transaction machinery in the way that reaches THIS
   * provider's containment close, with the message that failure surfaces.
   * Absent, the async-provider default applies: a transaction entry that
   * resolves without ever invoking the callback.
   */
  readonly breakTransaction?: (transport: object) => void;
  readonly brokenTransaction?: string;
}

/** The async providers' contract violation: a vanished transaction callback. */
function defaultBreakTransaction(transport: object): void {
  for (const entry of ["begin", "transaction"]) {
    Object.defineProperty(transport, entry, {
      configurable: true,
      value: () => Promise.resolve(),
    });
  }
}

const suppliedClientDrivers: readonly SuppliedClientDriver[] = [
  {
    name: "postgres.js",
    build: (options) => new PostgresDriver(options as never),
    shape: (transport) => transport,
  },
  {
    name: "Bun SQL",
    build: (options) => new BunSQLDriver(options as never),
    shape: (transport) => transport,
  },
  {
    name: "PGlite",
    build: (options) => new PGliteDriver(options as never),
    // PGlite dispatches its transaction on the provider's prototype, and a
    // caller's client is a PGlite.
    shape: (transport) =>
      Object.assign(Object.create(PGlite.prototype), transport),
  },
  {
    name: "SQLite3",
    build: (options) => new SQLite3Driver(options as never),
    // better-sqlite3 is synchronous: statements go through `prepare`, and
    // transaction control goes through `exec`. Both route into the shared
    // stand-in's counters so every arm reads one state shape.
    shape: (transport) => {
      const counted = transport as { unsafe: () => unknown };
      return Object.assign(transport, {
        exec: () => undefined,
        prepare: () => ({
          reader: true,
          safeIntegers: () => undefined,
          all: (): unknown[] => {
            counted.unsafe();
            return [];
          },
        }),
      });
    },
    // SQLite3's containment close fires when a CONTROL statement throws, not
    // when a provider swallows the callback — its transaction is VibORM's own
    // BEGIN/COMMIT over `exec`.
    breakTransaction: (transport) => {
      Object.defineProperty(transport, "exec", {
        configurable: true,
        value: () => {
          throw new Error("BEGIN refused by this transport");
        },
      });
    },
    // The control-statement failure surfaces through the query path's own
    // wrapper; the containment assertion (closed === 0) is the load-bearing
    // half for this subject.
    brokenTransaction: "Query execution failed",
  },
];

/**
 * A caller's transport, in the one shape all three providers reach for: it is
 * ended (`end`), closed (`close`), and queried (`unsafe`, `query`), and it
 * counts each.
 */
function suppliedTransport(subject: SuppliedClientDriver) {
  const state = { closed: 0, statements: 0 };
  const rows: unknown[] = [];
  Object.assign(rows, { count: 0, command: "SELECT" });
  const transport = subject.shape({
    end: () => {
      state.closed += 1;
      return Promise.resolve();
    },
    close: () => {
      state.closed += 1;
      return Promise.resolve();
    },
    unsafe: () => {
      state.statements += 1;
      return Promise.resolve(rows);
    },
    query: () => {
      state.statements += 1;
      return Promise.resolve({ rows: [], affectedRows: 0 });
    },
  });
  return { state, transport };
}

/** The value a settled promise rejected with, or a marker for a resolution. */
function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => new Error("the work was expected to fail"),
    (error: unknown) => error
  );
}

/** An options record whose `client` getter answers a different value per read. */
function answeringClient(answers: readonly unknown[]) {
  const state = { reads: 0 };
  const options = {
    namespace: "alpha",
    get client(): unknown {
      state.reads += 1;
      return answers[Math.min(state.reads, answers.length) - 1];
    },
  };
  return { state, options };
}

/** The client a driver holds after connecting, or the failure that stopped it. */
async function clientAfterConnect(driver: TransportOwner): Promise<unknown> {
  try {
    await driver._connect();
  } catch (thrown) {
    return thrown;
  }
  return Reflect.get(driver, "client");
}

for (const subject of suppliedClientDrivers) {
  describe(`${subject.name} settles supplied-client identity at construction`, () => {
    it("installs the exact client it was handed, from ONE read", () => {
      const supplied = suppliedTransport(subject);
      const { state, options } = answeringClient([
        supplied.transport,
        supplied.transport,
        supplied.transport,
      ]);

      const driver = subject.build(options);

      expect(state.reads).toBe(1);
      expect(Reflect.get(driver, "client")).toBe(supplied.transport);
    });

    it("installs nothing when the first read answers none", async () => {
      const supplied = suppliedTransport(subject);
      const { state, options } = answeringClient([
        undefined,
        supplied.transport,
        supplied.transport,
      ]);

      const driver = subject.build(options);

      // Ownership and installation are the same one answer. Reading again gave
      // this driver the caller's transport to hold while still believing it had
      // made its own — and a driver that believes that closes it.
      expect(state.reads).toBe(1);
      expect(Reflect.get(driver, "client")).toBe(null);
      await driver._disconnect();
      expect(supplied.state.closed).toBe(0);
    });

    it("keeps the client a later read withdraws", () => {
      const supplied = suppliedTransport(subject);
      const { state, options } = answeringClient([
        supplied.transport,
        undefined,
        undefined,
      ]);

      const driver = subject.build(options);

      expect(state.reads).toBe(1);
      expect(Reflect.get(driver, "client")).toBe(supplied.transport);
    });

    it("refuses construction when the client accessor throws", () => {
      let reads = 0;
      const options = {
        namespace: "alpha",
        get client(): unknown {
          reads += 1;
          throw new RangeError("the client cannot be read");
        },
      };

      expect(() => subject.build(options)).toThrow(RangeError);
      expect(reads).toBe(1);
    });

    it("never closes a supplied client, and reinstalls that exact one", async () => {
      const supplied = suppliedTransport(subject);
      const driver = subject.build({
        client: supplied.transport,
        namespace: "alpha",
      });

      await driver._disconnect();
      expect(supplied.state.closed).toBe(0);

      // Reconnecting used to build a transport the caller never asked for,
      // pointed wherever the options record said by then, and never closed it.
      expect(await clientAfterConnect(driver)).toBe(supplied.transport);
      expect(supplied.state.closed).toBe(0);
    });

    it("leaves a sibling wrapper over that client operational", async () => {
      const supplied = suppliedTransport(subject);
      const alpha = subject.build({
        client: supplied.transport,
        namespace: "alpha",
      });
      const beta = subject.build({
        client: supplied.transport,
        namespace: "beta",
      });

      await alpha._disconnect();

      // Two schema-scoped estates over one transport: disconnecting one is not
      // a licence to end the other one's database.
      expect(Reflect.get(beta, "client")).toBe(supplied.transport);
      await beta._executeRaw("SELECT 1");
      expect(supplied.state.statements).toBe(1);
      expect(supplied.state.closed).toBe(0);
    });

    it("never closes a supplied client to contain a broken transaction", async () => {
      const supplied = suppliedTransport(subject);
      // The contract violation whose containment closes the transport, in this
      // provider's own shape.
      (subject.breakTransaction ?? defaultBreakTransaction)(supplied.transport);
      const driver = subject.build({
        client: supplied.transport,
        namespace: "alpha",
      });

      const thrown = await rejection(
        driver._transaction(() => Promise.resolve("never runs"))
      );

      expect(thrown instanceof Error ? thrown.message : "").toContain(
        subject.brokenTransaction ?? "without invoking the transaction callback"
      );
      expect(supplied.state.closed).toBe(0);
    });

    it("still closes and recreates a client it made itself", async () => {
      const driver = subject.build({ namespace: "alpha" });
      const created: unknown[] = [];
      const closed: unknown[] = [];
      Object.defineProperty(driver, "initClient", {
        configurable: true,
        value: () => {
          const own = suppliedTransport(subject).transport;
          Object.defineProperty(own, "end", {
            configurable: true,
            value: () => {
              closed.push(own);
              return Promise.resolve();
            },
          });
          Object.defineProperty(own, "close", {
            configurable: true,
            value: () => {
              closed.push(own);
              return Promise.resolve();
            },
          });
          created.push(own);
          return Promise.resolve(own);
        },
      });

      for (const _round of [0, 1, 2]) {
        await driver._connect();
        await driver._disconnect();
      }

      expect(new Set(created).size).toBe(3);
      expect(closed).toEqual(created);
    });
  });
}

describe("pg settles supplied-pool ownership at construction", () => {
  it("never ends a supplied pool, even after the key is deleted", async () => {
    const supplied = suppliedPgPool();
    const options: PgDriverOptions = {
      pool: supplied.pool,
      namespace: "alpha",
    };
    const driver = new PgDriver(options);

    // The caller's record is theirs; they may clear or reuse it. Ownership was
    // settled from the pool this driver was HANDED, not from that record.
    Reflect.deleteProperty(options, "pool");
    await driver._disconnect();

    expect(supplied.state.ended).toBe(0);
  });

  it("still ends a pool it created after a pool key appears", async () => {
    const supplied = suppliedPgPool();
    const options: PgDriverOptions = {
      options: { host: "127.0.0.1", port: 1 },
    };
    const driver = new PgDriver(options);
    await driver._connect();
    const ended: unknown[] = [];
    const created = countEnds(Reflect.get(driver, "client"), ended);

    options.pool = supplied.pool;
    await driver._disconnect();

    expect(ended).toEqual([created]);
    expect(supplied.state.ended).toBe(0);
  });

  it("reuses the caller's pool across repeated reconnects", async () => {
    const supplied = suppliedPgPool();
    const driver = new PgDriver({
      pool: supplied.pool,
      namespace: "alpha",
    });

    for (const _round of [0, 1, 2]) {
      await driver._connect();
      // Reconnecting used to build a NEW pool here and then decline to close
      // it, because the ownership question was still answered "supplied".
      expect(Reflect.get(driver, "client")).toBe(supplied.pool);
      await driver._disconnect();
    }

    expect(supplied.state.ended).toBe(0);
  });

  it("ends every pool it creates across repeated reconnects", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    const created: unknown[] = [];
    const ended: unknown[] = [];

    for (const _round of [0, 1, 2]) {
      await driver._connect();
      created.push(countEnds(Reflect.get(driver, "client"), ended));
      await driver._disconnect();
    }

    expect(new Set(created).size).toBe(3);
    expect(ended).toEqual(created);
  });

  it("reconnects with the configuration it was BUILT with", async () => {
    const connection: PoolConfig = {
      host: "127.0.0.1",
      port: 1,
      user: "alice",
    };
    const options: PgDriverOptions = { options: connection };
    const driver = new PgDriver(options);
    await driver._connect();
    await driver._disconnect();

    // Both directions of the same record: a nested key and a top-level one.
    connection.user = "mallory";
    options.databaseUrl = "postgres://mallory@127.0.0.1:1/elsewhere";
    await driver._connect();
    const pool = Reflect.get(driver, "client");

    expect(readPath(pool, "options", "user")).toBe("alice");
    expect(readPath(pool, "options", "connectionString")).toBe(undefined);
    countEnds(pool, []);
    await driver._disconnect();
  });
});

describe("pg listens only on the pool it owns", () => {
  it("subscribes exactly once to the pool it creates", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();

    // Zero was the crash: pg emits 'error' on the pool for an idle client whose
    // socket dies, and an unheard 'error' is an uncaughtException. Two would be
    // a driver that resubscribes and reports the same failure twice.
    expect(createdPgPool(driver).listenerCount("error")).toBe(1);

    await driver._disconnect();
  });

  it("unsubscribes only after that pool has ended", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    const duringEnd: number[] = [];
    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => {
        duringEnd.push(pool.listenerCount("error"));
        return Promise.resolve();
      },
    });

    await driver._disconnect();

    // `end()` disposes the idle clients, and each one still carries pg's own
    // idle listener, which re-emits on this pool for a socket that dies on the
    // way out. Unsubscribing first reopens the crash for exactly that window.
    expect(duringEnd).toEqual([1]);
    expect(pool.listenerCount("error")).toBe(0);
  });

  it("keeps containment and retained evidence when the pool refuses to end", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    const background = Object.assign(new Error("idle connection died"), {
      code: "57P01",
    });
    pool.emit("error", background);
    const endFailure = new Error("pool did not close");
    let endAttempts = 0;
    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => {
        endAttempts += 1;
        return Promise.reject(endFailure);
      },
    });

    const disconnectFailure = await rejection(driver._disconnect());

    expect(readPath(disconnectFailure, "code")).toBe("V1001");
    expect(readSuppressedFailures(disconnectFailure)).toEqual([background]);
    expect(pool.listenerCount("error")).toBe(1);
    expect(endAttempts).toBe(1);

    // A rejected close retains this exact pool only for cleanup retry. A
    // provider may already have made it unusable before rejecting, so neither
    // connect nor query work can reach it and no replacement pool is created.
    let queryAttempts = 0;
    Object.defineProperty(pool, "query", {
      configurable: true,
      value: () => {
        queryAttempts += 1;
        return Promise.resolve({ command: "SELECT", rowCount: 0, rows: [] });
      },
    });
    await expect(driver._connect()).rejects.toMatchObject({
      code: "V1003",
    });
    await expect(driver._executeRaw("SELECT 1")).rejects.toMatchObject({
      code: "V1003",
    });
    expect(queryAttempts).toBe(0);
    expect(Reflect.get(driver, "client")).toBeNull();

    // The public rejection already carries the idle failure, exactly once.
    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => {
        endAttempts += 1;
        return Promise.resolve();
      },
    });
    await driver._disconnect();
    expect(endAttempts).toBe(2);
    expect(pool.listenerCount("error")).toBe(0);

    // Only proven cleanup reopens initialization. The old pool stays ended and
    // a fresh owned pool receives its own one listener.
    await driver._connect();
    const replacement = createdPgPool(driver);
    expect(replacement).not.toBe(pool);
    expect(replacement.listenerCount("error")).toBe(1);
    Object.defineProperty(replacement, "end", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    await driver._disconnect();
    expect(replacement.listenerCount("error")).toBe(0);
  });

  it("subscribes to a supplied pool never, and unsubscribes never", async () => {
    const supplied = suppliedPgPool();
    const driver = new PgDriver({
      pool: supplied.pool,
      namespace: "alpha",
    });

    await driver._connect();
    await driver._disconnect();

    // A caller's pool is borrowed transport whose events are theirs. A listener
    // added here is what STOPS Node from throwing, so VibORM would be silencing
    // a crash for a caller who never asked — and for the sibling estate sharing
    // that pool, which may be listening precisely to hear it.
    expect(supplied.state.subscribed).toBe(0);
    expect(supplied.state.unsubscribed).toBe(0);
    expect(supplied.state.ended).toBe(0);
  });

  it("keeps the acquisition failure primary and retains the pool's background failure", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () =>
        Promise.reject(
          Object.assign(new Error("no connection available"), { code: "53300" })
        ),
    });

    // Exactly what pg does for an idle client whose socket dies: an emit on the
    // pool, from no request at all.
    pool.emit(
      "error",
      Object.assign(new Error("terminating connection due to administrator"), {
        code: "57P01",
      })
    );

    const thrown = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );

    // The current acquisition is the requested action and stays primary. The
    // background failure is the half no request-scoped channel could surface,
    // so it remains inspectable beside the primary rather than replacing it.
    expect(readPath(thrown, "code")).toBe("V1001");
    expect(readPath(thrown, "meta", "providerCode")).toBe("53300");
    expect(readPath(thrown, "originalCause", "code")).toBe("53300");
    const [background] = readSuppressedFailures(thrown);
    expect(readPath(background, "code")).toBe("57P01");
    expect(
      Object.getOwnPropertyDescriptor(thrown, "suppressedFailures")
    ).toMatchObject({
      enumerable: false,
      value: [background],
    });

    // Reported once and released, so the next failure speaks for itself instead
    // of inheriting an explanation that has already been given.
    const next = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );
    expect(readPath(next, "meta", "providerCode")).toBe("53300");
    expect(readSuppressedFailures(next)).toEqual([]);

    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    await driver._disconnect();
  });

  it("clears the retained failure once an acquisition succeeds", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);

    pool.emit(
      "error",
      Object.assign(new Error("terminating connection due to administrator"), {
        code: "57P01",
      })
    );

    // The pool replaced the dead connection: a healed transport must not
    // explain a later, unrelated failure.
    const client = { query: () => Promise.resolve(), release: () => undefined };
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.resolve(client),
    });
    await driver
      ._transaction(() => Promise.resolve("runs"))
      .catch(() => undefined);

    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.reject(new Error("no connection available")),
    });
    const thrown = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );
    expect(readPath(thrown, "meta", "providerCode")).toBe(undefined);

    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    await driver._disconnect();
  });

  for (const route of ["typed", "raw"]) {
    it(`clears retained evidence after a successful ordinary ${route} pool query`, async () => {
      const driver = new PgDriver({
        options: { host: "127.0.0.1", port: 1 },
      });
      await driver._connect();
      const pool = createdPgPool(driver);
      pool.emit("error", new Error("idle connection died"));
      Object.defineProperty(pool, "query", {
        configurable: true,
        value: () =>
          Promise.resolve({ rows: [], rowCount: 0, command: "SELECT" }),
      });

      if (route === "typed") {
        await driver._execute(sql`SELECT 1`);
      } else {
        await driver._executeRaw("SELECT 1");
      }

      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () => Promise.reject(new Error("unrelated acquisition failure")),
      });
      const unrelated = await rejection(
        driver._transaction(() => Promise.resolve("never runs"))
      );
      expect(readSuppressedFailures(unrelated)).toEqual([]);

      Object.defineProperty(pool, "end", {
        configurable: true,
        value: () => Promise.resolve(),
      });
      await driver._disconnect();
    });
  }

  for (const route of ["typed", "raw"]) {
    it(`surfaces retained evidence on a failed ordinary ${route} pool query`, async () => {
      const driver = new PgDriver({
        options: { host: "127.0.0.1", port: 1 },
      });
      await driver._connect();
      const pool = createdPgPool(driver);
      const background = new Error("idle connection died");
      const queryFailure = Object.assign(new Error("statement failed"), {
        code: "XX000",
      });
      pool.emit("error", background);
      Object.defineProperty(pool, "query", {
        configurable: true,
        value: () => Promise.reject(queryFailure),
      });

      const thrown = await rejection(
        route === "typed"
          ? driver._execute(sql`SELECT 1`)
          : driver._executeRaw("SELECT 1")
      );
      expect(readPath(thrown, "code")).toBe("V2001");
      expect(readPath(thrown, "originalCause", "code")).toBe("XX000");
      expect(readSuppressedFailures(thrown)).toEqual([background]);

      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () => Promise.reject(new Error("later acquisition failed")),
      });
      const later = await rejection(
        driver._transaction(() => Promise.resolve("never runs"))
      );
      expect(readSuppressedFailures(later)).toEqual([]);

      Object.defineProperty(pool, "end", {
        configurable: true,
        value: () => Promise.resolve(),
      });
      await driver._disconnect();
    });
  }

  it("does not assign pool evidence to a PoolClient query failure", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    const background = new Error("idle connection died during transaction");
    const statementFailure = new Error("transaction statement failed");
    const pooledClient = {
      query: (statement: string) => {
        if (statement === "BEGIN") {
          pool.emit("error", background);
          return Promise.resolve();
        }
        if (statement === "BROKEN") return Promise.reject(statementFailure);
        return Promise.resolve();
      },
      release: () => undefined,
    };
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.resolve(pooledClient),
    });

    const transactionFailure = await rejection(
      driver.withTransaction((tx) => tx._executeRaw("BROKEN"))
    );
    expect(readSuppressedFailures(transactionFailure)).toEqual([]);

    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.reject(new Error("next acquisition failed")),
    });
    const next = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );
    expect(readSuppressedFailures(next)).toEqual([background]);

    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    await driver._disconnect();
  });

  it("clears evidence when a maxWait acquisition succeeds after abandonment", async () => {
    vi.useFakeTimers();
    try {
      const driver = new PgDriver({
        options: { host: "127.0.0.1", port: 1 },
      });
      await driver._connect();
      const pool = createdPgPool(driver);
      const background = new Error("idle connection died");
      pool.emit("error", background);
      let resolveAcquisition: (client: object) => void = () => {
        throw new Error("the acquisition has not started");
      };
      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () =>
          new Promise<object>((resolve) => {
            resolveAcquisition = resolve;
          }),
      });

      const timedOutFailure = rejection(
        driver._transaction(() => Promise.resolve("never runs"), {
          maxWait: 20,
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      expect(readPath(await timedOutFailure, "code")).toBe("V5002");

      const release = vi.fn();
      resolveAcquisition({ query: () => Promise.resolve(), release });
      await vi.advanceTimersByTimeAsync(0);
      expect(release).toHaveBeenCalledOnce();

      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () => Promise.reject(new Error("next acquisition failed")),
      });
      const next = await rejection(
        driver._transaction(() => Promise.resolve("never runs"))
      );
      expect(readSuppressedFailures(next)).toEqual([]);

      Object.defineProperty(pool, "end", {
        configurable: true,
        value: () => Promise.resolve(),
      });
      await driver._disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps evidence when a maxWait acquisition rejects after abandonment", async () => {
    vi.useFakeTimers();
    try {
      const driver = new PgDriver({
        options: { host: "127.0.0.1", port: 1 },
      });
      await driver._connect();
      const pool = createdPgPool(driver);
      const background = new Error("idle connection died");
      pool.emit("error", background);
      let connectCalls = 0;
      let rejectAcquisition: (reason: unknown) => void = () => {
        throw new Error("the acquisition has not started");
      };
      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () => {
          connectCalls += 1;
          return new Promise((_resolve, reject) => {
            rejectAcquisition = reject;
          });
        },
      });

      const timedOutFailure = rejection(
        driver._transaction(() => Promise.resolve("never runs"), {
          maxWait: 20,
        })
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(connectCalls).toBe(1);
      await vi.advanceTimersByTimeAsync(20);
      expect(readPath(await timedOutFailure, "code")).toBe("V5002");

      rejectAcquisition(new Error("late abandoned rejection"));
      await Promise.resolve();
      Object.defineProperty(pool, "connect", {
        configurable: true,
        value: () => Promise.reject(new Error("next acquisition failed")),
      });
      const next = await rejection(
        driver._transaction(() => Promise.resolve("never runs"))
      );
      expect(readSuppressedFailures(next)).toEqual([background]);

      Object.defineProperty(pool, "end", {
        configurable: true,
        value: () => Promise.resolve(),
      });
      await driver._disconnect();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let an older concurrent acquisition erase a later event", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    pool.emit("error", new Error("first idle connection died"));
    const acquisitions: Array<(client: object) => void> = [];
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () =>
        new Promise<object>((resolve) => {
          acquisitions.push(resolve);
        }),
    });
    const pooledClient = {
      query: () => Promise.resolve(),
      release: () => undefined,
    };

    const first = driver._transaction(() => Promise.resolve("first"));
    const older = driver._transaction(() => Promise.resolve("older"));
    await Promise.resolve();
    await Promise.resolve();
    expect(acquisitions).toHaveLength(2);

    acquisitions[0]?.(pooledClient);
    await expect(first).resolves.toBe("first");
    const later = new Error("later idle connection died");
    pool.emit("error", later);
    acquisitions[1]?.(pooledClient);
    await expect(older).resolves.toBe("older");

    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.reject(new Error("next acquisition failed")),
    });
    const next = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );
    expect(readSuppressedFailures(next)).toEqual([later]);

    Object.defineProperty(pool, "end", {
      configurable: true,
      value: () => Promise.resolve(),
    });
    await driver._disconnect();
  });
});

describe("MySQL2 settles supplied-pool ownership at construction", () => {
  it("never ends a supplied pool, even after the key is deleted", async () => {
    const supplied = suppliedMySQLPool();
    const options: MySQL2DriverOptions = {
      pool: supplied.pool as never,
      namespace: "alpha",
    };
    const driver = new MySQL2Driver(options);

    Reflect.deleteProperty(options, "pool");
    await driver._disconnect();

    expect(supplied.state.ended).toBe(0);
  });

  it("still ends a pool it created after a pool key appears", async () => {
    const supplied = suppliedMySQLPool();
    const options: MySQL2DriverOptions = {
      options: { host: "127.0.0.1", port: 1 },
    };
    const driver = new MySQL2Driver(options);
    await driver._connect();
    const ended: unknown[] = [];
    const created = countEnds(Reflect.get(driver, "client"), ended);

    options.pool = supplied.pool as never;
    await driver._disconnect();

    expect(ended).toEqual([created]);
    expect(supplied.state.ended).toBe(0);
  });

  it("reuses the caller's pool across repeated reconnects", async () => {
    const supplied = suppliedMySQLPool();
    const driver = new MySQL2Driver({
      pool: supplied.pool as never,
      namespace: "alpha",
    });

    for (const _round of [0, 1, 2]) {
      await driver._connect();
      expect(Reflect.get(driver, "client")).toBe(supplied.pool);
      await driver._disconnect();
    }

    expect(supplied.state.ended).toBe(0);
  });

  it("ends every pool it creates across repeated reconnects", async () => {
    const driver = new MySQL2Driver({
      databaseUrl: "mysql://root:pw@127.0.0.1:1/alpha",
    });
    const created: unknown[] = [];
    const ended: unknown[] = [];

    for (const _round of [0, 1, 2]) {
      await driver._connect();
      created.push(countEnds(Reflect.get(driver, "client"), ended));
      await driver._disconnect();
    }

    expect(new Set(created).size).toBe(3);
    expect(ended).toEqual(created);
  });

  it("reconnects with the configuration it was BUILT with", async () => {
    const connection: PoolOptions = {
      host: "127.0.0.1",
      port: 1,
      user: "alice",
    };
    const driver = new MySQL2Driver({ options: connection });
    await driver._connect();
    await driver._disconnect();

    connection.user = "mallory";
    await driver._connect();
    const pool = Reflect.get(driver, "client");

    expect(readPath(pool, "pool", "config", "connectionConfig", "user")).toBe(
      "alice"
    );
    countEnds(pool, []);
    await driver._disconnect();
  });
});
