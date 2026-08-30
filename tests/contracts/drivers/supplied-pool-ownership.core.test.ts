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
import { SQLite3Driver } from "@drivers/sqlite3";
import { PGlite } from "@electric-sql/pglite";
import type { PoolOptions } from "mysql2/promise";
import { Pool, type PoolConfig } from "pg";
import { describe, expect, it } from "vitest";

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
  const pool = {
    end: () => {
      state.ended += 1;
      return Promise.resolve();
    },
    query: () => Promise.reject(new Error("not used")),
    connect: () => Promise.reject(new Error("not used")),
    on: () => {
      state.subscribed += 1;
    },
    off: () => {
      state.unsubscribed += 1;
    },
  };
  return { state, pool };
}

/** The real pool a pg driver built for itself, refusing anything else. */
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
      pool: supplied.pool as never,
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

    options.pool = supplied.pool as never;
    await driver._disconnect();

    expect(ended).toEqual([created]);
    expect(supplied.state.ended).toBe(0);
  });

  it("reuses the caller's pool across repeated reconnects", async () => {
    const supplied = suppliedPgPool();
    const driver = new PgDriver({
      pool: supplied.pool as never,
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

  it("subscribes to a supplied pool never, and unsubscribes never", async () => {
    const supplied = suppliedPgPool();
    const driver = new PgDriver({
      pool: supplied.pool as never,
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

  it("explains an acquisition failure with the pool's last background failure", async () => {
    const driver = new PgDriver({ options: { host: "127.0.0.1", port: 1 } });
    await driver._connect();
    const pool = createdPgPool(driver);
    Object.defineProperty(pool, "connect", {
      configurable: true,
      value: () => Promise.reject(new Error("no connection available")),
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

    // The background failure is the half nothing else can ever surface: no
    // execution context exists where it arrives, and every channel this layer
    // has is execution-scoped. The acquisition failure beside it is the same
    // transport failing a second time.
    expect(readPath(thrown, "code")).toBe("V1001");
    expect(readPath(thrown, "meta", "providerCode")).toBe("57P01");

    // Reported once and released, so the next failure speaks for itself instead
    // of inheriting an explanation that has already been given.
    const next = await rejection(
      driver._transaction(() => Promise.resolve("never runs"))
    );
    expect(readPath(next, "meta", "providerCode")).toBe(undefined);

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
