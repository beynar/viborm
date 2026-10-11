/**
 * The pinned migration session's time limits (plan S1), its rule for a dead
 * connection (plan S2) and its transaction-scoped lock (plan D1), on the ONE
 * owner every locked command shares —
 * `apply`, `down`, `reset`, `baseline`, `resolve`, `verify` and `push` all
 * reach the database through `withLockedMigrationProducer`.
 *
 * The recording estate driver is the assertion surface: what matters is which
 * statements the session sends, in which order, and — after a connection
 * failure — which ones it does NOT send. Real servers are in
 * `postgres-session-limits.test.ts` (PGlite) and
 * `postgres-session-limits-docker.test.ts` (PostgreSQL 16).
 */

import { createClient } from "@client/client";
import { BunSQLDriver } from "@drivers/bun-sql";
import type { PinnedSessionReservation } from "@drivers/shared";
import {
  CLEANUP_BOUND_MS,
  DEFAULT_MIGRATION_LIMITS,
  releaseReservedPostgresSession,
} from "@drivers/shared/pinned-session";
import { readSuppressedFailures } from "@drivers/shared/suppressed-failure";
import { ConnectionError, VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations/client";
import { getMigrationDriver } from "@migrations/drivers";
import {
  resolveMigrationLimits,
  withLockedMigrationProducer,
  withPinnedSession,
} from "@migrations/pinned-session";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  mysqlEstateDriver,
  pgEstateDriver,
  RecordingDriver,
  sqliteEstateDriver,
} from "./_estate";

const LIMITS_ENTER = /^DO \$viborm_limits\$/;
const LIMITS_RESET = /set_config\(name, reset_val, false\)/;
const LOCK = /pg_try_advisory_lock/;
const XACT_LOCK = /pg_try_advisory_xact_lock/;
const UNLOCK = /pg_advisory_unlock\(/;
const POSTGRES_LIMITS = /set_config|DO \$/;

/** The namespace proof every PostgreSQL locked command runs. */
function answerPublicSchema(sql: string): unknown[] {
  return sql.includes("pg_namespace") ? [{ present: 1 }] : [];
}

/**
 * A PostgreSQL estate driver whose reservation reports what the provider saw,
 * as `pg` does through its client's `error` event, and how it was released.
 */
class ObservedSessionDriver extends RecordingDriver {
  lostConnection: Error | undefined;
  readonly releases: { discard: boolean; lost: boolean | undefined }[] = [];

  protected override pinnedSession(): Promise<
    PinnedSessionReservation<{ tag: "client" } | { tag: "tx" }>
  > {
    const session: { tag: "tx" } = { tag: "tx" };
    return Promise.resolve({
      session,
      lost: () => this.lostConnection,
      release: (discard, lost) => {
        this.releases.push({ discard, lost });
        return Promise.resolve();
      },
    });
  }
}

const RELEASE_REJECTED = new Error("the pool refused the connection back");

/** A reservation whose release the pool rejects. */
class RejectingReleaseDriver extends RecordingDriver {
  protected override pinnedSession(): Promise<
    PinnedSessionReservation<{ tag: "client" } | { tag: "tx" }>
  > {
    return Promise.resolve({
      session: { tag: "tx" },
      release: () => Promise.reject(RELEASE_REJECTED),
    });
  }
}

function observedPg(): ObservedSessionDriver {
  const template = pgEstateDriver("public");
  return new ObservedSessionDriver("postgresql", "pg", template.adapter);
}

/** One locked command whose body runs one DDL statement in a transaction. */
function lockedDdl(driver: RecordingDriver, ddl = "ALTER TABLE t ADD c int") {
  return withLockedMigrationProducer(
    driver,
    getMigrationDriver(driver),
    (pinned) =>
      pinned._transaction(async () => {
        await pinned._executeRaw(ddl);
        return "applied";
      })
  );
}

const CONCURRENT_BUILD = 'CREATE INDEX CONCURRENTLY "i" ON "public"."t" ("c")';

/**
 * The same command after stepwise work: the CONCURRENTLY statement takes the
 * session lock and sets the session's limits (plan D1).
 */
function lockedStepwiseDdl(
  driver: RecordingDriver,
  ddl = "ALTER TABLE t ADD c int"
) {
  return withLockedMigrationProducer(
    driver,
    getMigrationDriver(driver),
    async (pinned) => {
      await pinned._executeRaw(CONCURRENT_BUILD);
      return pinned._transaction(async () => {
        await pinned._executeRaw(ddl);
        return "applied";
      });
    }
  );
}

/** The limits every migration transaction opens with, at the defaults. */
const TRANSACTION_LIMITS = `SELECT set_config('lock_timeout', '${DEFAULT_MIGRATION_LIMITS.lockTimeout}', true), set_config('statement_timeout', '${DEFAULT_MIGRATION_LIMITS.statementTimeout}', true), set_config('idle_in_transaction_session_timeout', CASE WHEN pg_catalog.version() LIKE '%emscripten%' THEN pg_catalog.current_setting('idle_in_transaction_session_timeout') ELSE '${DEFAULT_MIGRATION_LIMITS.idleTimeout}' END, true)`;

afterEach(() => {
  vi.useRealTimers();
});

describe("the session's time limits", () => {
  test("each transaction opens with its own limits and the transaction lock; the session is left alone", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;

    await expect(lockedDdl(driver)).resolves.toBe("applied");

    const { statements } = driver;
    expect(statements.slice(0, 2)).toEqual(["BEGIN", TRANSACTION_LIMITS]);
    expect(statements[2]).toMatch(XACT_LOCK);
    expect(statements[2]).toContain("interval '10 seconds'");
    expect(statements.slice(-2)).toEqual(["ALTER TABLE t ADD c int", "COMMIT"]);
    // One transaction: the body's continues the one that took the lock.
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    const session = statements.filter(
      (sql) =>
        LIMITS_ENTER.test(sql) ||
        LIMITS_RESET.test(sql) ||
        LOCK.test(sql) ||
        UNLOCK.test(sql)
    );
    expect(session).toEqual([]);
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });

  test("stepwise work sets the session limits under its session lock, and resets them before release", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;

    await expect(lockedStepwiseDdl(driver)).resolves.toBe("applied");

    const { statements } = driver;
    const lock = statements.findIndex((sql) => LOCK.test(sql));
    const enter = statements.findIndex((sql) => LIMITS_ENTER.test(sql));
    const firstCommit = statements.indexOf("COMMIT");
    const build = statements.indexOf(CONCURRENT_BUILD);
    const begin = statements.lastIndexOf("BEGIN");
    const unlock = statements.findIndex((sql) => UNLOCK.test(sql));
    const reset = statements.findIndex((sql) => LIMITS_RESET.test(sql));
    // Taken inside the locked transaction, before it commits.
    expect(statements.slice(0, lock).some((sql) => XACT_LOCK.test(sql))).toBe(
      true
    );
    expect(enter).toBe(lock + 1);
    expect(firstCommit).toBe(enter + 1);
    expect(build).toBeGreaterThan(firstCommit);
    // A later transaction under the session lock still opens with its limits.
    expect(statements[begin + 1]).toBe(TRANSACTION_LIMITS);
    expect(statements[begin + 2]).toBe("ALTER TABLE t ADD c int");
    expect(reset).toBe(statements.length - 1);
    expect(unlock).toBe(reset - 1);
    expect(statements[enter]).toContain(
      `set_config('lock_timeout', '${DEFAULT_MIGRATION_LIMITS.lockTimeout}', false), set_config('statement_timeout', '${DEFAULT_MIGRATION_LIMITS.statementTimeout}', false)`
    );
    expect(statements[enter]).toContain("idle_session_timeout");
    expect(statements[enter]).toContain("idle_in_transaction_session_timeout");
    expect(statements[reset]).toContain("'lock_timeout', 'statement_timeout'");
    expect(driver.sessions).toEqual(["reserve", "release"]);
  });

  test("the command's own limits reach the lock deadline, the transaction and the session", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const limits = resolveMigrationLimits({
      lockTimeout: 1500,
      statementTimeout: 90_000,
      idleTimeout: 2500,
      lockWait: 3000,
    });
    const bound = getMigrationDriver(driver, undefined, limits);

    await withLockedMigrationProducer(driver, bound, async (pinned) => {
      await pinned._executeRaw(CONCURRENT_BUILD);
      await pinned._transaction(() =>
        pinned._executeRaw("ALTER TABLE t ADD c int")
      );
    });

    const [, transaction, lock] = driver.statements;
    expect(transaction).toContain(
      "set_config('lock_timeout', '1500', true), set_config('statement_timeout', '90000', true)"
    );
    expect(transaction).toContain("ELSE '2500' END");
    expect(lock).toContain("interval '3 seconds'");
    const enter = driver.statements.find((sql) => LIMITS_ENTER.test(sql));
    expect(enter).toContain(
      "set_config('lock_timeout', '1500', false), set_config('statement_timeout', '90000', false)"
    );
    expect(enter).toContain("set_config(name, '2500', false)");
  });

  test("a CONCURRENTLY index statement runs with no limits, which are restored after it", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const build = 'CREATE INDEX CONCURRENTLY "a_idx" ON "public"."a" ("b")';
    const refresh = 'REFRESH MATERIALIZED VIEW CONCURRENTLY "public"."v"';
    const comment = `COMMENT ON TABLE "public"."a" IS 'rebuilt concurrently'`;

    await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async (pinned) => {
        await pinned._executeRaw(build);
        await pinned._executeRaw(refresh);
        await pinned._executeRaw(comment);
      }
    );

    const at = driver.statements.indexOf(build);
    expect(driver.statements.slice(at - 1, at + 4)).toEqual([
      "SELECT set_config('lock_timeout', '0', false), set_config('statement_timeout', '0', false)",
      build,
      "SELECT set_config('lock_timeout', '4000', false), set_config('statement_timeout', '600000', false)",
      refresh,
      comment,
    ]);
  });

  test("the limits are lifted by an index statement's head, never by the words in a comment", async () => {
    const driver = pgEstateDriver("public");
    driver.respond = answerPublicSchema;
    const annotated =
      'ALTER TABLE "public"."a" ADD "c" int /* INDEX CONCURRENTLY */';
    const noted =
      '-- note\nCREATE INDEX CONCURRENTLY "a_idx" ON "public"."a" ("b")';
    const lift =
      "SELECT set_config('lock_timeout', '0', false), set_config('statement_timeout', '0', false)";

    await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async (pinned) => {
        await pinned._executeRaw(annotated);
        await pinned._executeRaw(noted);
      }
    );

    const { statements } = driver;
    expect(statements.filter((sql) => sql === lift)).toHaveLength(1);
    expect(statements[statements.indexOf(noted) - 1]).toBe(lift);
    expect(statements.slice(0, 2)).toEqual(["BEGIN", TRANSACTION_LIMITS]);
    expect(statements.indexOf(annotated)).toBeLessThan(
      statements.indexOf("COMMIT")
    );
  });

  test("MySQL keeps its own session: no PostgreSQL limits are sent", async () => {
    const driver = mysqlEstateDriver({ namespace: "alpha", attested: true });
    driver.respond = (sql) => {
      if (sql.includes("SCHEMATA")) return [{ SCHEMA_NAME: "alpha" }];
      if (sql.includes("@@SESSION.sql_mode")) {
        return [{ sql_mode: "STRICT_TRANS_TABLES", server_version: "8.4.0" }];
      }
      return [];
    };

    await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async () => "ran"
    );

    expect(driver.statements.join("\n")).not.toMatch(POSTGRES_LIMITS);
  });

  test("the reservation wait is bounded with a retryable connection timeout, and a late reservation goes back discarded", async () => {
    const driver = observedPg();
    let deliver: (() => void) | undefined;
    const released: boolean[] = [];
    Reflect.set(
      driver,
      "pinnedSession",
      () =>
        new Promise<PinnedSessionReservation<{ tag: "tx" }>>((resolve) => {
          deliver = () =>
            resolve({
              session: { tag: "tx" },
              release: (discard) => {
                released.push(discard);
                return Promise.resolve();
              },
            });
        })
    );

    const started = Date.now();
    const failure = await withPinnedSession(driver, async () => "ran", {
      connectionWait: 50,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
    });
    expect(Date.now() - started).toBeLessThan(1000);
    deliver?.();
    await vi.waitFor(() => expect(released).toEqual([true]));
    expect(driver.statements).toEqual([]);
  });
});

describe("a session whose connection was lost is never written to again", () => {
  test("a connection failure in the transaction skips ROLLBACK, the unlock and the reset, and surfaces V1001", async () => {
    const driver = observedPg();
    const dead = new Error("Connection terminated unexpectedly");
    driver.respond = (sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        // pg reports the socket through the client's `error` event, and the
        // statement itself as an ordinary query failure.
        driver.lostConnection = dead;
        return dead;
      }
      return answerPublicSchema(sql);
    };

    const failure = await lockedDdl(driver).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ConnectionError);
    expect(failure).toMatchObject({ code: VibORMErrorCode.CONNECTION_FAILED });
    expect(driver.statements.at(-1)).toBe("ALTER TABLE t ADD c int");
    expect(driver.statements).not.toContain("ROLLBACK");
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("a provider connection code is recognized without the provider's own report", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("write CONNECTION_CLOSED"), {
            code: "CONNECTION_CLOSED",
          })
        : answerPublicSchema(sql);

    const failure = await lockedDdl(driver).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: VibORMErrorCode.CONNECTION_FAILED });
    expect(driver.statements.at(-1)).toBe("COMMIT");
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("a lost connection at the lock statement is a retryable connection failure, not a lock failure", async () => {
    const driver = observedPg();
    driver.lockAnswers.acquire = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    const failure = await lockedDdl(driver).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: VibORMErrorCode.CONNECTION_FAILED });
    expect(driver.statements.at(-1)).toMatch(XACT_LOCK);
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("an ordinary failure still rolls the locked transaction back on the reserved session", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      sql.startsWith("ALTER TABLE")
        ? Object.assign(new Error("column exists"), { code: "42701" })
        : answerPublicSchema(sql);

    const failure = await lockedDdl(driver).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(ConnectionError);
    expect(driver.statements.slice(-2)).toEqual([
      "ALTER TABLE t ADD c int",
      "ROLLBACK",
    ]);
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });

  test("an ordinary failure after stepwise work rolls back, unlocks and resets on the reserved session", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      sql.startsWith("ALTER TABLE")
        ? Object.assign(new Error("column exists"), { code: "42701" })
        : answerPublicSchema(sql);

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    expect(failure).not.toBeInstanceOf(ConnectionError);
    const tail = driver.statements.slice(-3);
    expect(tail[0]).toBe("ROLLBACK");
    expect(tail[1]).toMatch(UNLOCK);
    expect(tail[2]).toMatch(LIMITS_RESET);
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });

  test("a cleanup statement that never answers is bounded, and the session is then lost", async () => {
    vi.useFakeTimers();
    const driver = observedPg();
    driver.respond = (sql) =>
      sql.startsWith("ALTER TABLE")
        ? new Error("column exists")
        : answerPublicSchema(sql);
    const run = Reflect.get(driver, "executeRaw");
    Reflect.set(
      driver,
      "executeRaw",
      function (this: RecordingDriver, ...args: unknown[]) {
        if (args[1] !== "ROLLBACK") return Reflect.apply(run, this, args);
        driver.statements.push("ROLLBACK");
        return new Promise<never>(() => undefined);
      }
    );

    const settled = lockedDdl(driver).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLEANUP_BOUND_MS);
    const failure = await settled;

    // The command's own failure stays primary; the unanswered ROLLBACK is
    // reported beside it and is why nothing more was sent.
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      code: VibORMErrorCode.CONNECTION_TIMEOUT,
    });
    expect(driver.statements.at(-1)).toBe("ROLLBACK");
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });
});

describe("a lock protocol statement that fails", () => {
  /** One locked command that only reads: the decision transaction it opens is committed by the command's end. */
  const lockedRead = (driver: RecordingDriver) =>
    withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async (pinned) => {
        await pinned._executeRaw("SELECT 1");
        return "read";
      }
    );

  test("a busy SQLite database is a lock failure: its lock IS its BEGIN IMMEDIATE", async () => {
    const driver = sqliteEstateDriver();
    const busy = Object.assign(new Error("database is locked"), {
      code: "SQLITE_BUSY",
    });
    driver.respond = (sql) => (sql === "BEGIN IMMEDIATE" ? busy : []);

    const failure = await lockedRead(driver).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
      message: expect.stringContaining(
        "Failed to acquire the migration lock for the SQLite database: the lock statement itself failed."
      ),
      // The driver's normalized report of the provider's own failure.
      cause: expect.objectContaining({ originalCause: expect.any(Error) }),
    });
    expect(driver.statements.at(-1)).toBe("BEGIN IMMEDIATE");
    expect(driver.statements).not.toContain("SELECT 1");
  });

  test("a PostgreSQL BEGIN the server rejects is that rejection, not a lock failure", async () => {
    const driver = observedPg();
    const refused = Object.assign(new Error("out of shared memory"), {
      code: "53200",
    });
    driver.respond = (sql) =>
      sql === "BEGIN" ? refused : answerPublicSchema(sql);

    const failure = await lockedRead(driver).catch((error: unknown) => error);

    expect(failure).not.toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
    });
    expect(failure).not.toBeInstanceOf(ConnectionError);
    expect(driver.statements.at(-1)).toBe("BEGIN");
    expect(driver.statements).not.toContain("SELECT 1");
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });

  test("a COMMIT that fails at the command's end fails it, after a ROLLBACK on the same session", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      sql === "COMMIT"
        ? Object.assign(new Error("could not serialize access"), {
            code: "40001",
          })
        : answerPublicSchema(sql);

    const failure = await lockedRead(driver).catch((error: unknown) => error);

    expect(failure).toMatchObject({ meta: { providerCode: "40001" } });
    expect(driver.statements.slice(-2)).toEqual(["COMMIT", "ROLLBACK"]);
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });

  test("a ROLLBACK that fails is recorded beside the command's failure, never instead of it", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      sql === "ROLLBACK"
        ? Object.assign(new Error("rollback refused"), { code: "XX000" })
        : answerPublicSchema(sql);
    const bodyFailure = new Error("the command failed after its read");

    const failure = await withLockedMigrationProducer(
      driver,
      getMigrationDriver(driver),
      async (pinned) => {
        await pinned._executeRaw("SELECT 1");
        throw bodyFailure;
      }
    ).catch((error: unknown) => error);

    expect(failure).toBe(bodyFailure);
    expect(readSuppressedFailures(failure)).toEqual([
      expect.objectContaining({
        meta: expect.objectContaining({ providerCode: "XX000" }),
      }),
    ]);
    expect(driver.statements.at(-1)).toBe("ROLLBACK");
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });

  test("after stepwise work, a lost connection sends neither ROLLBACK nor the unlock", async () => {
    const driver = observedPg();
    const dead = new Error("Connection terminated unexpectedly");
    driver.respond = (sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        driver.lostConnection = dead;
        return dead;
      }
      return answerPublicSchema(sql);
    };

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({ code: VibORMErrorCode.CONNECTION_FAILED });
    // The server frees the session lock with the session.
    expect(driver.statements.at(-1)).toBe("ALTER TABLE t ADD c int");
    expect(driver.statements.some((sql) => UNLOCK.test(sql))).toBe(false);
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("a release the pool rejects after a failure is recorded beside it", async () => {
    const driver = new RejectingReleaseDriver(
      "postgresql",
      "pg",
      pgEstateDriver("public").adapter
    );
    driver.respond = (sql) =>
      sql.startsWith("ALTER TABLE")
        ? Object.assign(new Error("column exists"), { code: "42701" })
        : answerPublicSchema(sql);

    const failure = await lockedDdl(driver).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(readSuppressedFailures(failure)).toEqual([RELEASE_REJECTED]);
  });

  test("stepwise work after a committed group first re-takes the transaction lock, then the session lock", async () => {
    const driver = observedPg();
    driver.respond = answerPublicSchema;

    await expect(
      withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async (pinned) => {
          await pinned._transaction(() =>
            pinned._executeRaw("ALTER TABLE t ADD c int")
          );
          await pinned._executeRaw(CONCURRENT_BUILD);
          return "ran";
        }
      )
    ).resolves.toBe("ran");

    const afterCommit = driver.statements.slice(
      driver.statements.indexOf("COMMIT") + 1
    );
    expect(afterCommit[0]).toBe("BEGIN");
    expect(afterCommit[1]).toBe(TRANSACTION_LIMITS);
    expect(afterCommit[2]).toMatch(XACT_LOCK);
    expect(afterCommit[3]).toMatch(LOCK);
    expect(afterCommit).toContain(CONCURRENT_BUILD);
    expect(driver.releases).toEqual([{ discard: false, lost: false }]);
  });

  test("a lost connection at the unlock is the connection failure, not a lock failure", async () => {
    const driver = observedPg();
    driver.respond = answerPublicSchema;
    driver.lockAnswers.release = Object.assign(new Error("read ECONNRESET"), {
      code: "ECONNRESET",
    });

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({ code: VibORMErrorCode.CONNECTION_FAILED });
    expect(driver.statements.at(-1)).toMatch(UNLOCK);
    // Nothing is sent after it: no limits reset on a dead session.
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("an unlock the server rejects discards the session with a lock failure naming the schema", async () => {
    const driver = observedPg();
    driver.respond = answerPublicSchema;
    driver.lockAnswers.release = Object.assign(new Error("unlock rejected"), {
      code: "XX000",
    });

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
      message: expect.stringContaining(
        'Failed to release the migration lock for schema "public". The pinned session was discarded'
      ),
      // The provider's rejection, as the driver reports a failed statement.
      cause: expect.objectContaining({ code: VibORMErrorCode.QUERY_FAILED }),
    });
    // The connection is alive, so its limits are still reset before it is
    // discarded.
    expect(driver.statements.at(-2)).toMatch(UNLOCK);
    expect(driver.statements.at(-1)).toMatch(LIMITS_RESET);
    expect(driver.releases).toEqual([{ discard: true, lost: false }]);
  });
});

describe("a session whose limits could not be reset is never handed back", () => {
  /**
   * An ordinary failure, then a limits reset the server refuses. Only a
   * session that ran stepwise work carries limits to reset (plan D1).
   */
  function failingReset(driver: ObservedSessionDriver) {
    driver.respond = (sql) => {
      if (sql.startsWith("ALTER TABLE")) {
        return Object.assign(new Error("column exists"), { code: "42701" });
      }
      return LIMITS_RESET.test(sql)
        ? new Error("reset refused")
        : answerPublicSchema(sql);
    };
  }

  test("a rejected reset after a failed command still releases, abandoned, with the command's failure primary", async () => {
    const driver = observedPg();
    failingReset(driver);

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    // Both arrive as the driver's query failure; the ALTER's stays primary.
    const [resetFailure] = readSuppressedFailures(failure);
    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(resetFailure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(resetFailure).not.toBe(failure);
    expect(readSuppressedFailures(failure)).toHaveLength(1);
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("an unanswered reset after a failed command is bounded, then released abandoned", async () => {
    vi.useFakeTimers();
    const driver = observedPg();
    failingReset(driver);
    const run = Reflect.get(driver, "executeRaw");
    Reflect.set(
      driver,
      "executeRaw",
      function (this: RecordingDriver, ...args: unknown[]) {
        if (!LIMITS_RESET.test(String(args[1]))) {
          return Reflect.apply(run, this, args);
        }
        return new Promise<never>(() => undefined);
      }
    );

    const settled = lockedStepwiseDdl(driver).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(CLEANUP_BOUND_MS);
    const failure = await settled;

    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(readSuppressedFailures(failure)).toEqual([
      expect.objectContaining({ code: VibORMErrorCode.CONNECTION_TIMEOUT }),
    ]);
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });

  test("a rejected reset after a successful command fails it, and the session is abandoned", async () => {
    const driver = observedPg();
    driver.respond = (sql) =>
      LIMITS_RESET.test(sql)
        ? new Error("reset refused")
        : answerPublicSchema(sql);

    const failure = await lockedStepwiseDdl(driver).catch(
      (error: unknown) => error
    );

    expect(failure).toMatchObject({ code: VibORMErrorCode.QUERY_FAILED });
    expect(driver.statements.at(-1)).toMatch(LIMITS_RESET);
    expect(driver.releases).toEqual([{ discard: true, lost: true }]);
  });
});

describe("a lost reserved postgres.js / Bun SQL session is abandoned", () => {
  const sent: string[] = [];
  const reservation = (closeOwnedTransport?: () => Promise<void>) => ({
    driverName: "postgres",
    discard: true,
    lost: true,
    reset: () => {
      sent.push("reset");
      return Promise.resolve();
    },
    release: () => {
      sent.push("release");
    },
    closeOwnedTransport,
  });

  test("an owned transport is closed, and nothing is sent or released", async () => {
    sent.length = 0;
    await expect(
      releaseReservedPostgresSession(
        reservation(() => {
          sent.push("close");
          return Promise.resolve();
        })
      )
    ).resolves.toBeUndefined();
    expect(sent).toEqual(["close"]);
  });

  test("a supplied transport is abandoned and reported", async () => {
    sent.length = 0;
    await expect(
      releaseReservedPostgresSession(reservation())
    ).rejects.toMatchObject({
      code: VibORMErrorCode.CONNECTION_CLOSED,
      message: expect.stringContaining(
        "lost the connection of a reserved migration session"
      ),
    });
    expect(sent).toEqual([]);
  });
});

describe("Bun SQL hands its lost reserved session to the shared release", () => {
  test("nothing more is sent on it, and the transport it created closes within the cleanup bound", async () => {
    const events: string[] = [];
    const reserved = {
      unsafe: (sql: string) => {
        events.push(`reserved:${sql}`);
        return Promise.resolve([]);
      },
      release: () => {
        events.push("release");
      },
    };
    const transport = {
      reserve: () => Promise.resolve(reserved),
      close: (options?: { readonly timeout?: number }) => {
        events.push(`close:${options?.timeout}`);
        return Promise.resolve();
      },
    };
    const driver = new BunSQLDriver({});
    Object.defineProperty(driver, "initClient", {
      configurable: true,
      value: () => Promise.resolve(transport),
    });
    const gone = new ConnectionError("socket closed", {
      code: VibORMErrorCode.CONNECTION_CLOSED,
    });

    const failure = await withPinnedSession(driver, (_pinned, control) => {
      control.lost(gone);
      return Promise.reject(gone);
    }).catch((error: unknown) => error);
    await Promise.resolve();

    expect(failure).toBe(gone);
    expect(events).toEqual([`close:${CLEANUP_BOUND_MS / 1000}`]);
  });
});

describe("migration time limits are settled once", () => {
  test("a migration client refuses invalid limits when it is created, before any command", () => {
    const driver = pgEstateDriver("public");
    const client = createClient({ driver, schema: {} });

    expect(() =>
      createMigrationClient(client, { limits: { lockWait: 0 } })
    ).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.INVALID_INPUT,
        message: expect.stringContaining("lockWait"),
      })
    );
    expect(driver.statements).toEqual([]);
  });

  test("defaults fill every key the caller left out", () => {
    expect(resolveMigrationLimits(undefined)).toBe(DEFAULT_MIGRATION_LIMITS);
    expect(resolveMigrationLimits({ lockTimeout: 0 })).toEqual({
      ...DEFAULT_MIGRATION_LIMITS,
      lockTimeout: 0,
    });
    expect(
      resolveMigrationLimits({ statementTimeout: 0, lockWait: 60_000 })
    ).toMatchObject({ statementTimeout: 0, lockWait: 60_000 });
  });

  test.each([
    [{ lockTimeout: -1 }, "lockTimeout"],
    [{ idleTimeout: 1.5 }, "idleTimeout"],
    [{ lockWait: 0 }, "lockWait"],
    [{ connectionWait: "10s" }, "connectionWait"],
    [{ statementTimeout: 10_000 }, "longer than lockWait"],
    [{ statementTimeout: 3_000_000_000 }, "from 0 to 2147483647"],
    [{ lockTimeOut: 10 }, "unknown key lockTimeOut"],
    [{ largeTableRows: -1 }, "largeTableRows must be a whole number of rows"],
  ])("refuses %o", (input, message) => {
    expect(() => resolveMigrationLimits(input)).toThrowError(
      expect.objectContaining({
        code: VibORMErrorCode.INVALID_INPUT,
        message: expect.stringContaining(message),
      })
    );
  });
});
