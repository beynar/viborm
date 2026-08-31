/**
 * A pinned session is the primitive migration locking is built on, and its
 * whole point is exclusivity: every statement of the session — the lock, the
 * authoritative reads, the DDL, the unlock — must run on ONE physical producer,
 * and nothing else may run on that producer while it is held.
 *
 * The provider suites prove the reservation and release against real
 * transports. What is proven here is the part that is the same on every
 * transport and that no provider can demonstrate: the capability answer given
 * before any provider work, the refusal when there is nothing to reserve, the
 * exclusivity the lease provides on a single-connection driver and across two
 * drivers over ONE client, and the view handed to the body — which must be the
 * same driver in every respect except that it can neither reserve a second
 * session nor accept a bound it cannot apply.
 */

import type { DatabaseAdapter } from "@adapters/database-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { Driver } from "@drivers/driver";
import type {
  PinnedSessionControl,
  PinnedSessionReservation,
  TransactionOptionSupport,
} from "@drivers/shared";
import type { QueryResult } from "@drivers/types";
import { describe, expect, test } from "vitest";

interface FakeSession {
  readonly id: string;
}

const NO_SESSION = /No session can be reserved through this driver/;
const NO_QUEUE_WAIT = /pinned session holds the connection queue/;

const QUEUE_SUPPORT: TransactionOptionSupport = {
  isolationLevel: "unsupported",
  isolationLevelReason: "this recording driver opens no configurable session",
  timeout: true,
  maxWait: "queue",
};

const ACQUISITION_SUPPORT: TransactionOptionSupport = {
  isolationLevel: "unsupported",
  isolationLevelReason: "this recording driver opens no configurable session",
  timeout: true,
  maxWait: "acquisition",
};

/** A promise this test settles by hand, standing in for unfinished work. */
function held() {
  let settle: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    settle = () => resolve();
  });
  return { promise, settle: () => settle?.() };
}

/** Drain the microtask queue so a pending lease has certainly been taken. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1) {
    await Promise.resolve();
  }
}

interface PinnableOptions {
  readonly serialize?: boolean;
  readonly sharedClient?: FakeSession;
  readonly support?: TransactionOptionSupport;
}

/** A driver that records which producer every statement was dispatched on. */
class PinnableDriver extends Driver<FakeSession, FakeSession> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();
  readonly dispatched: string[] = [];
  readonly releases: boolean[] = [];
  protected override readonly serializeTransactions: boolean;
  private readonly options: PinnableOptions;
  private reserved = 0;

  constructor(options: PinnableOptions = {}) {
    super("postgresql", "pinnable");
    this.options = options;
    this.serializeTransactions = options.serialize === true;
  }

  protected override transactionOptionSupport(): TransactionOptionSupport {
    return this.options.support ?? super.transactionOptionSupport();
  }

  protected override pinnedSession(): Promise<
    PinnedSessionReservation<FakeSession>
  > {
    this.reserved += 1;
    const session: FakeSession = { id: `reserved-${this.reserved}` };
    return Promise.resolve({
      session,
      release: (discard: boolean) => {
        this.releases.push(discard);
        return Promise.resolve();
      },
    });
  }

  protected initClient(): Promise<FakeSession> {
    return Promise.resolve(this.options.sharedClient ?? { id: "base" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(
    client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.dispatched.push(`${client.id}:${statement}`);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(
    client: FakeSession,
    statement: string
  ): Promise<QueryResult<T>> {
    this.dispatched.push(`${client.id}:${statement}`);
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: FakeSession,
    fn: (tx: FakeSession) => Promise<T>
  ): Promise<T> {
    this.dispatched.push(`${client.id}:PROVIDER TRANSACTION`);
    return fn(client);
  }
}

/** The single-connection shape: one client several drivers may be built over. */
class SharedSessionDriver extends PinnableDriver {
  protected override physicalPinnedSession(): Promise<object> {
    return this.getClient();
  }
}

/** A transport with no interactive session to reserve at all. */
class StatelessDriver extends Driver<FakeSession, FakeSession> {
  readonly adapter: DatabaseAdapter = new PostgresAdapter();

  constructor() {
    super("postgresql", "stateless");
  }

  protected initClient(): Promise<FakeSession> {
    return Promise.resolve({ id: "stateless" });
  }

  protected closeClient(): Promise<void> {
    return Promise.resolve();
  }

  protected execute<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected executeRaw<T>(): Promise<QueryResult<T>> {
    return Promise.resolve({ rows: [], rowCount: 0 });
  }

  protected transaction<T>(
    client: FakeSession,
    fn: (tx: FakeSession) => Promise<T>
  ): Promise<T> {
    return fn(client);
  }
}

describe("pinning capability is answered before any provider work", () => {
  test("reports the capability from the presence of the reservation hook", () => {
    expect(new PinnableDriver()._canPinSession()).toBe(true);
    expect(new StatelessDriver()._canPinSession()).toBe(false);
  });

  test("refuses to run a pinned body on a transport with no session", async () => {
    const driver = new StatelessDriver();

    await expect(
      driver._withPinnedSession(() => Promise.resolve("unreachable"))
    ).rejects.toThrow(NO_SESSION);
  });

  test("withdraws the hook from the view, so a nested pin refuses instead of taking a second connection", async () => {
    const driver = new PinnableDriver();
    let nested: unknown;

    await driver._withPinnedSession(async (pinned) => {
      expect(pinned._canPinSession()).toBe(false);
      nested = await pinned
        ._withPinnedSession(() => Promise.resolve("second"))
        .catch((caught: unknown) => caught);
      return "done";
    });

    expect(nested).toBeInstanceOf(Error);
    expect((nested as Error).message).toMatch(NO_SESSION);
    // Exactly one producer was ever reserved.
    expect(driver.releases).toEqual([false]);
  });
});

describe("the pinned view is the same driver on one producer", () => {
  test("dispatches the body's statements on the reserved session", async () => {
    const driver = new PinnableDriver();

    await expect(
      driver._withPinnedSession(async (pinned) => {
        expect(pinned.adapter).toBe(driver.adapter);
        await pinned._executeRaw("SELECT pg_advisory_lock(1)");
        await pinned._executeRaw("SELECT pg_advisory_unlock(1)");
        return "locked";
      })
    ).resolves.toBe("locked");

    expect(driver.dispatched).toEqual([
      "reserved-1:SELECT pg_advisory_lock(1)",
      "reserved-1:SELECT pg_advisory_unlock(1)",
    ]);
    expect(driver.releases).toEqual([false]);
  });

  test("runs a transaction on the reserved session instead of acquiring another", async () => {
    const driver = new PinnableDriver();

    await expect(
      driver._withPinnedSession((pinned) =>
        pinned._transaction(async (tx) => {
          await pinned._executeRaw("CREATE TABLE entry (id int)");
          return tx.id;
        })
      )
    ).resolves.toBe("reserved-1");

    // BEGIN/COMMIT are issued on the reserved producer itself: the provider's
    // own `transaction()` would have taken a second connection.
    expect(driver.dispatched).toEqual([
      "reserved-1:BEGIN",
      "reserved-1:CREATE TABLE entry (id int)",
      "reserved-1:COMMIT",
    ]);
  });

  test("rolls the pinned transaction back on the reserved session", async () => {
    const driver = new PinnableDriver();

    await expect(
      driver._withPinnedSession((pinned) =>
        pinned._transaction(() => Promise.reject(new Error("DDL failed")))
      )
    ).rejects.toThrow("DDL failed");

    expect(driver.dispatched).toEqual([
      "reserved-1:BEGIN",
      "reserved-1:ROLLBACK",
    ]);
    // A body that threw condemns its producer.
    expect(driver.releases).toEqual([true]);
  });

  test("refuses a queue-bounded maxWait the lease has already consumed", async () => {
    const driver = new PinnableDriver({
      serialize: true,
      support: QUEUE_SUPPORT,
    });

    await driver._withPinnedSession(async (pinned) => {
      await expect(
        pinned._transaction(() => Promise.resolve("started"), { maxWait: 10 })
      ).rejects.toThrow(NO_QUEUE_WAIT);
      return "done";
    });
  });

  test("keeps an acquisition-bounded maxWait the view can still apply", async () => {
    const driver = new PinnableDriver({ support: ACQUISITION_SUPPORT });

    await driver._withPinnedSession(async (pinned) => {
      await expect(
        pinned._transaction(() => Promise.resolve("started"), { maxWait: 10 })
      ).resolves.toBe("started");
      return "done";
    });

    expect(driver.dispatched).toEqual([
      "reserved-1:BEGIN",
      "reserved-1:COMMIT",
    ]);
  });
});

describe("pinned session exclusivity", () => {
  test("holds a single-connection driver's queue for the whole session", async () => {
    const driver = new PinnableDriver({ serialize: true });
    const gate = held();
    const order: string[] = [];

    const pinning = driver._withPinnedSession(async () => {
      order.push("session-start");
      await gate.promise;
      order.push("session-end");
      return "pinned";
    });
    const ordinary = driver
      ._executeRaw("SELECT ordinary")
      .then(() => order.push("ordinary"));

    await flush();
    expect(order).toEqual(["session-start"]);
    gate.settle();
    await Promise.all([pinning, ordinary]);

    expect(order).toEqual(["session-start", "session-end", "ordinary"]);
  });

  test("keeps a second driver over the same client out of an open session", async () => {
    const sharedClient: FakeSession = { id: "shared" };
    const first = new SharedSessionDriver({ serialize: true, sharedClient });
    const second = new SharedSessionDriver({ serialize: true, sharedClient });
    const gate = held();
    const order: string[] = [];

    const holding = first._withPinnedSession(async () => {
      order.push("first-start");
      await gate.promise;
      order.push("first-end");
      return "first";
    });
    await flush();
    const waiting = second._withPinnedSession(() => {
      order.push("second");
      return Promise.resolve("second");
    });
    await flush();

    // A session advisory lock is reentrant, so the second command must not be
    // let in beside the first: it would re-acquire the lock the first holds.
    expect(order).toEqual(["first-start"]);
    gate.settle();
    await expect(holding).resolves.toBe("first");
    await expect(waiting).resolves.toBe("second");
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  test("reports a body failure rather than its successful release", async () => {
    const driver = new PinnableDriver();

    await expect(
      driver._withPinnedSession(() =>
        Promise.reject(new Error("migration body failed"))
      )
    ).rejects.toThrow("migration body failed");
    expect(driver.releases).toEqual([true]);
  });

  test("condemns a producer the body asked to discard", async () => {
    const driver = new PinnableDriver();

    await expect(
      driver._withPinnedSession((_pinned, control: PinnedSessionControl) => {
        control.discard();
        return Promise.resolve("unlock could not be proven");
      })
    ).resolves.toBe("unlock could not be proven");
    expect(driver.releases).toEqual([true]);
  });
});
