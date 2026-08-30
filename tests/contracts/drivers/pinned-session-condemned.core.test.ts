/**
 * A discarded pinned producer whose reset FAILED never re-enters service.
 *
 * `pg` and MySQL2 expose a destructive return — `release(true)`, `destroy()` —
 * so their condemned sessions are proven gone. postgres.js, Bun SQL and PGlite
 * expose none: they were reset with `pg_advisory_unlock_all()` and handed back
 * regardless of whether that reset succeeded, so a session that might still
 * hold VibORM's migration lock went straight back into the pool, or stayed the
 * driver's one usable client. The next command then blocks forever on a lock
 * nobody owns, or — on PGlite's single reentrant session — silently runs inside
 * it.
 *
 * What each provider can honestly do differs, and this suite pins each answer:
 * a caller-owned transport is never closed to hide the problem, a transport the
 * driver created is closed, and a client that can be neither is condemned. The
 * condemnation follows that CLIENT, because the lock state it cannot account
 * for is the session's: a second wrapper over the same one is refused too.
 *
 * The Bun SQL arms run against a stand-in transport under Node. The Bun runtime
 * and a live Bun SQL server are not exercised here; what is proven is the
 * driver's own release path, which is where the defect lived.
 */

import { BunSQLDriver } from "@drivers/bun-sql";
import { PGliteDriver } from "@drivers/pglite";
import { PostgresDriver } from "@drivers/postgres";
import { readSuppressedFailures } from "@drivers/shared";
import {
  condemnPhysicalSession,
  leasePinnedCommand,
} from "@drivers/shared/pinned-session";
import { PGlite } from "@electric-sql/pglite";
import { ConnectionError } from "@errors";
import { describe, expect, it } from "vitest";

const RESET = "pg_advisory_unlock_all";

/** How a stand-in transport misbehaves. Everything defaults to behaving. */
interface TransportHostility {
  /** What the reset rejects with, when `resetFails` was asked for. */
  readonly resetRejection?: unknown;
  /** Whether ending this transport rejects too. */
  readonly closeFails?: boolean;
}

/**
 * A postgres.js/Bun-shaped transport whose reserved connection can fail its
 * reset. Both providers expose the same three members this path uses:
 * `reserve()`, the reserved connection's `unsafe()`, and its `release()`.
 *
 * `unsafe()` on the transport ITSELF is ordinary execution — the thing that
 * must never land on a transport whose closure failed.
 */
function reservingTransport(
  resetFails: boolean,
  hostility: TransportHostility = {}
) {
  const events: string[] = [];
  const reserved = {
    unsafe: (sql: string) => {
      events.push(`reserved:${sql}`);
      if (!resetFails) return Promise.resolve([]);
      return Promise.reject(
        "resetRejection" in hostility
          ? hostility.resetRejection
          : new Error("ECONNRESET: connection is closed")
      );
    },
    release: () => {
      events.push("release");
    },
  };
  const end = () => {
    events.push("end");
    return hostility.closeFails === true
      ? Promise.reject(new Error("the socket was already gone"))
      : Promise.resolve();
  };
  const transport = {
    unsafe: () => {
      events.push("ordinary");
      // Both providers hand back an array carrying the provider's own result
      // metadata, which ordinary execution normalizes before returning.
      return Promise.resolve(
        Object.assign([], { command: "SELECT", count: 0 })
      );
    },
    reserve: () => {
      events.push("reserve");
      return Promise.resolve(reserved);
    },
    end,
    close: end,
  };
  return { events, transport };
}

/**
 * Makes this exact PGlite fail the advisory reset, and only that statement.
 *
 * The client is the subject here, not the driver: what a failed reset leaves
 * unknown is the lock state of THIS session, whichever wrapper asked for it.
 */
function failResetOn(
  client: PGlite,
  rejectWith: unknown = new Error("the session is gone")
): void {
  const answer: unknown = Reflect.get(client, "query");
  Object.defineProperty(client, "query", {
    configurable: true,
    value: (sql: string, params?: unknown[]) =>
      sql.includes(RESET)
        ? Promise.reject(rejectWith)
        : Reflect.apply(
            typeof answer === "function" ? answer : () => undefined,
            client,
            [sql, params]
          ),
  });
}

/** A pinned session that condemns its producer and otherwise does nothing. */
function discardingBody(): (
  pinned: unknown,
  control: { discard(): void }
) => Promise<string> {
  return (_pinned, control) => {
    control.discard();
    return Promise.resolve("done");
  };
}

/** The value a settled promise rejected with, or a marker for a resolution. */
function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => new Error("the pinned session was expected to fail"),
    (error: unknown) => error
  );
}

describe("postgres.js condemns a session it cannot prove clean", () => {
  it("never returns a caller-owned reserved connection to its pool", async () => {
    const { events, transport } = reservingTransport(true);
    const driver = new PostgresDriver({ client: transport as never });

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));

    // The reset was attempted and failed, and the connection was NOT released:
    // postgres.js exposes no destroy, so abandoning it is the only way it stops
    // being a connection the pool will hand to the next caller.
    expect(events).toEqual(["reserve", `reserved:SELECT ${RESET}()`]);
    expect(thrown).toBeInstanceOf(Error);
    expect(thrown instanceof Error ? thrown.message : "").toContain(
      "advisory-lock state"
    );
  });

  it("closes the transport it created, and only that one", async () => {
    const { events, transport } = reservingTransport(true);
    const driver = new PostgresDriver({});
    Object.defineProperty(driver, "initClient", {
      configurable: true,
      value: () => Promise.resolve(transport),
    });

    await rejection(driver._withPinnedSession(discardingBody()));

    // A pool this driver created is its own to end, and ending it is what
    // terminates the abandoned backend — which is what actually frees the
    // advisory locks the reset could not.
    expect(events).toEqual(["reserve", `reserved:SELECT ${RESET}()`, "end"]);
    expect(Reflect.get(driver, "client")).toBe(null);
  });

  it("releases normally when the reset SUCCEEDS", async () => {
    const { events, transport } = reservingTransport(false);
    const driver = new PostgresDriver({ client: transport as never });

    await driver._withPinnedSession(discardingBody());

    expect(events).toEqual([
      "reserve",
      `reserved:SELECT ${RESET}()`,
      "release",
    ]);
  });

  it("keeps a body failure primary, with the condemnation beside it", async () => {
    const { transport } = reservingTransport(true);
    const driver = new PostgresDriver({ client: transport as never });
    const bodyFailure = new Error("the estate half-dropped");

    const thrown = await rejection(
      driver._withPinnedSession(() => Promise.reject(bodyFailure))
    );

    expect(thrown).toBe(bodyFailure);
    expect(bodyFailure.message).toBe("the estate half-dropped");
    expect(readSuppressedFailures(thrown)).toHaveLength(1);
  });
});

describe("Bun SQL condemns a session it cannot prove clean", () => {
  it("never returns a caller-owned reserved connection to its pool", async () => {
    const { events, transport } = reservingTransport(true);
    const driver = new BunSQLDriver({ client: transport as never });

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));

    expect(events).toEqual(["reserve", `reserved:SELECT ${RESET}()`]);
    expect(thrown instanceof Error ? thrown.message : "").toContain(
      "advisory-lock state"
    );
  });

  it("closes the transport it created, and only that one", async () => {
    const { events, transport } = reservingTransport(true);
    const driver = new BunSQLDriver({});
    Object.defineProperty(driver, "initClient", {
      configurable: true,
      value: () => Promise.resolve(transport),
    });

    await rejection(driver._withPinnedSession(discardingBody()));

    expect(events).toEqual(["reserve", `reserved:SELECT ${RESET}()`, "end"]);
    expect(Reflect.get(driver, "client")).toBe(null);
  });

  it("releases normally when the reset SUCCEEDS", async () => {
    const { events, transport } = reservingTransport(false);
    const driver = new BunSQLDriver({ client: transport as never });

    await driver._withPinnedSession(discardingBody());

    expect(events).toEqual([
      "reserve",
      `reserved:SELECT ${RESET}()`,
      "release",
    ]);
  });
});

describe("PGlite condemns the one client it cannot hand back", () => {
  it("refuses every later pinned session on a client it cannot prove clean", async () => {
    const client = new PGlite();
    try {
      failResetOn(client);
      const driver = new PGliteDriver({ client, namespace: "public" });

      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );

      // PGlite's one client IS the session, and it is the caller's database:
      // closing it would destroy their data to hide a cleanup failure. What is
      // left is to stop using it for migration work, which is what a session
      // whose lock state VibORM cannot account for has to mean.
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "advisory-lock state"
      );
      // Ordinary queries are untouched: the estate's data was never in doubt.
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });

  it("refuses pinning through EVERY wrapper over that one client", async () => {
    // The documented shape: two schema-scoped estates over ONE database, so two
    // drivers and one physical session.
    const shared = new PGlite();
    const independent = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      const elsewhere = new PGliteDriver({
        client: independent,
        namespace: "public",
      });

      const condemning = await rejection(
        alpha._withPinnedSession(discardingBody())
      );
      expect(condemning instanceof Error ? condemning.message : "").toContain(
        "advisory-lock state"
      );

      // What the failed reset left unknown is the CLIENT's lock state, not the
      // wrapper's: a PostgreSQL session advisory lock is reentrant, so beta's
      // command would re-acquire the lock alpha may still hold rather than wait
      // for it, and then read and write inside alpha's session. The refusal has
      // to land before the body, which is where those statements are written.
      let entered = false;
      const refused = await rejection(
        beta._withPinnedSession(() => {
          entered = true;
          return Promise.resolve("body ran");
        })
      );

      expect(entered).toBe(false);
      expect(refused instanceof Error ? refused.message : "").toContain(
        "advisory-lock state"
      );
      // A client that answered for none of this stays pinnable.
      await expect(
        elsewhere._withPinnedSession(() => Promise.resolve("ok"))
      ).resolves.toBe("ok");
    } finally {
      await shared.close();
      await independent.close();
    }
  });

  it("stays usable when the reset SUCCEEDS", async () => {
    const client = new PGlite();
    try {
      const driver = new PGliteDriver({ client, namespace: "public" });

      await driver._withPinnedSession(discardingBody());

      await expect(
        driver._withPinnedSession(() => Promise.resolve("again"))
      ).resolves.toBe("again");
    } finally {
      await client.close();
    }
  });
});

/**
 * A value whose `instanceof Error` test itself THROWS.
 *
 * The reset's rejection is a value the PROVIDER chose, and the condemnation is
 * built from it inside a `catch`: a normalizer that asks a hostile value what
 * it is fails there, and the typed refusal never gets built at all.
 */
function prototypeTrapProxy(): unknown {
  return new Proxy(
    {},
    {
      getPrototypeOf() {
        throw new Error("prototype trap");
      },
    }
  );
}

describe("a hostile reset rejection cannot replace the condemnation", () => {
  it("keeps postgres.js's typed refusal, with the reset kept as evidence", async () => {
    const { events, transport } = reservingTransport(true, {
      resetRejection: prototypeTrapProxy(),
    });
    const driver = new PostgresDriver({ client: transport as never });

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));

    // The family is the promise: a caller catching ConnectionError to contain a
    // condemned session catches nothing when the normalizer throws instead.
    expect(thrown).toBeInstanceOf(ConnectionError);
    expect(thrown instanceof Error ? thrown.message : "").toContain(
      "advisory-lock state"
    );
    // Normalized rather than dropped — the reset's own value is what says WHY
    // the lock state cannot be accounted for.
    expect(
      thrown instanceof ConnectionError ? thrown.originalCause : undefined
    ).toBeInstanceOf(Error);
    // The session still never went back to the pool.
    expect(events).toEqual(["reserve", `reserved:SELECT ${RESET}()`]);
  });

  it("keeps PGlite's typed refusal, and still condemns that client", async () => {
    const client = new PGlite();
    try {
      failResetOn(client, prototypeTrapProxy());
      const driver = new PGliteDriver({ client, namespace: "public" });

      const thrown = await rejection(
        driver._withPinnedSession(discardingBody())
      );

      expect(thrown).toBeInstanceOf(ConnectionError);
      expect(thrown instanceof Error ? thrown.message : "").toContain(
        "advisory-lock state"
      );
      expect(
        thrown instanceof ConnectionError ? thrown.originalCause : undefined
      ).toBeInstanceOf(Error);

      // The condemnation is the containment, and it does not depend on what the
      // provider chose to reject with.
      const second = await rejection(
        driver._withPinnedSession(() => Promise.resolve(1))
      );
      expect(second instanceof Error ? second.message : "").toContain(
        "will pin no further migration session"
      );
      // Ordinary queries are untouched, and nothing destructive was attempted.
      const rows = await driver._executeRaw("SELECT 1 AS one");
      expect(rows.rows).toEqual([{ one: 1 }]);
    } finally {
      await client.close();
    }
  });
});

describe("a command admitted BEFORE the condemnation", () => {
  it("is refused at the front of the queue, before its body", async () => {
    const session = {};
    let firstEntered!: () => void;
    const running = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondRan = false;

    const first = leasePinnedCommand("probe", session, async () => {
      firstEntered();
      await held;
      // Exactly what a failed reset does, at the moment it does it.
      condemnPhysicalSession(session);
      throw new Error("the reset failed");
    });
    await running;

    // Admitted while the first command is still running: nothing is condemned
    // yet, so the admission-time answer is "allowed" — and the session this
    // command was admitted onto stops being accountable before it runs.
    const second = leasePinnedCommand("probe", session, () => {
      secondRan = true;
      return Promise.resolve("ran");
    });

    releaseFirst();
    const firstOutcome = await rejection(first);
    const secondOutcome = await rejection(second);

    expect(secondRan).toBe(false);
    expect(firstOutcome instanceof Error ? firstOutcome.message : "").toBe(
      "the reset failed"
    );
    expect(secondOutcome).toBeInstanceOf(ConnectionError);
    expect(
      secondOutcome instanceof Error ? secondOutcome.message : ""
    ).toContain("will pin no further migration session");
  });

  it("refuses a second wrapper's whole command over one PGlite", async () => {
    // The documented shape: two schema-scoped estates over ONE database, with
    // the second command admitted while the first still holds the session.
    const shared = new PGlite();
    const independent = new PGlite();
    try {
      failResetOn(shared);
      const alpha = new PGliteDriver({ client: shared, namespace: "public" });
      const beta = new PGliteDriver({ client: shared, namespace: "public" });
      const elsewhere = new PGliteDriver({
        client: independent,
        namespace: "public",
      });

      let alphaEntered!: () => void;
      const running = new Promise<void>((resolve) => {
        alphaEntered = resolve;
      });
      let releaseAlpha!: () => void;
      const held = new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });

      const condemning = rejection(
        alpha._withPinnedSession(async (_pinned, control) => {
          alphaEntered();
          await held;
          control.discard();
          return "done";
        })
      );
      await running;

      let bodyRan = false;
      const refused = rejection(
        beta._withPinnedSession(async (pinned) => {
          bodyRan = true;
          await pinned._executeRaw("CREATE TABLE beta_ran (id int)");
          return "body ran";
        })
      );
      // A timer drains every pending microtask, so beta has reached the lease —
      // and been admitted onto a session nobody has condemned yet — before the
      // first command's reset is allowed to fail.
      await new Promise((resolve) => setTimeout(resolve, 0));

      releaseAlpha();
      const condemnation = await condemning;
      expect(
        condemnation instanceof Error ? condemnation.message : ""
      ).toContain("advisory-lock state");

      const outcome = await refused;
      expect(bodyRan).toBe(false);
      expect(outcome instanceof Error ? outcome.message : "").toContain(
        "will pin no further migration session"
      );
      // Neither the body nor its statement reached the client: a PostgreSQL
      // session advisory lock is reentrant, so beta's DDL would have run inside
      // the session alpha may still hold rather than waiting for it.
      const created = await alpha._executeRaw(
        "SELECT to_regclass('beta_ran') AS present"
      );
      expect(created.rows).toEqual([{ present: null }]);

      // A client that answered for none of this stays pinnable.
      await expect(
        elsewhere._withPinnedSession(() => Promise.resolve("ok"))
      ).resolves.toBe("ok");
    } finally {
      await shared.close();
      await independent.close();
    }
  });
});

describe("a transport whose owned closure FAILED", () => {
  /**
   * A driver that makes its own transports, handing out a fresh one each time
   * it connects — which is how "the exact transport is never used again" can be
   * observed at all.
   */
  function transportMakingDriver<TDriver extends object>(
    driver: TDriver,
    made: ReturnType<typeof reservingTransport>[]
  ): TDriver {
    Object.defineProperty(driver, "initClient", {
      configurable: true,
      value: () => {
        // Only the FIRST transport fails its reset; the replacement is an
        // ordinary healthy one, so anything landing on the first is a reuse.
        const next = reservingTransport(made.length === 0, {
          closeFails: true,
        });
        made.push(next);
        return Promise.resolve(next.transport);
      },
    });
    return driver;
  }

  it("is withdrawn by postgres.js, which then says so truthfully", async () => {
    const made: ReturnType<typeof reservingTransport>[] = [];
    const driver = transportMakingDriver(new PostgresDriver({}), made);

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));
    await driver._executeRaw("SELECT 1");

    // The condemned transport was withdrawn before the close was even
    // attempted, so ordinary execution reached a NEW one. Left installed, the
    // next query runs on the exact connection whose lock state is what could
    // not be accounted for.
    expect(made).toHaveLength(2);
    expect(made[0]?.events).toEqual([
      "reserve",
      `reserved:SELECT ${RESET}()`,
      "end",
    ]);
    expect(made[1]?.events).toEqual(["ordinary"]);

    // The reset stays primary and the close failure stays beside it as cleanup
    // evidence — the caller acts on the lock state, not on the socket.
    expect(thrown).toBeInstanceOf(ConnectionError);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("advisory-lock state");
    expect(readSuppressedFailures(thrown)).toHaveLength(1);
    // The close FAILED. Claiming the backend was ended is a claim about a
    // connection that may still be running — holding the very lock this
    // refusal exists to report.
    expect(message).not.toContain("was closed");
  });

  it("is withdrawn by Bun SQL, which then says so truthfully", async () => {
    const made: ReturnType<typeof reservingTransport>[] = [];
    const driver = transportMakingDriver(new BunSQLDriver({}), made);

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));
    await driver._executeRaw("SELECT 1");

    expect(made).toHaveLength(2);
    expect(made[0]?.events).toEqual([
      "reserve",
      `reserved:SELECT ${RESET}()`,
      "end",
    ]);
    expect(made[1]?.events).toEqual(["ordinary"]);

    expect(thrown).toBeInstanceOf(ConnectionError);
    const message = thrown instanceof Error ? thrown.message : "";
    expect(message).toContain("advisory-lock state");
    expect(readSuppressedFailures(thrown)).toHaveLength(1);
    expect(message).not.toContain("was closed");
  });

  it("is never a transport the CALLER owns", async () => {
    const { events, transport } = reservingTransport(true, {
      closeFails: true,
    });
    const driver = new PostgresDriver({ client: transport as never });

    const thrown = await rejection(driver._withPinnedSession(discardingBody()));

    expect(thrown).toBeInstanceOf(ConnectionError);
    expect(thrown instanceof Error ? thrown.message : "").toContain(
      "belongs to the caller"
    );
    expect(readSuppressedFailures(thrown)).toHaveLength(0);

    await driver._executeRaw("SELECT 1");

    // Never closed, never withdrawn: it is the caller's transport, may be
    // serving their own code, and ending it to tidy up VibORM's cleanup
    // failure would be a far larger effect than the one being contained.
    expect(events).toEqual([
      "reserve",
      `reserved:SELECT ${RESET}()`,
      "ordinary",
    ]);
  });
});
