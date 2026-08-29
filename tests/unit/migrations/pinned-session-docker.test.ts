/**
 * The pinned migration session on a real server.
 *
 * A pooled connection is the whole subject here, and PGlite has exactly one
 * session — so the facts that matter are only observable against a server:
 * two clients on two connections racing for one advisory lock, a lock that is
 * genuinely session-scoped, and a producer that has to be the same physical
 * connection across a commit boundary. Two independent schema estates share one
 * database so the cross-estate boundary is a real one.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import type { AnyDriver } from "@drivers/driver";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { getMigrationDriver } from "@migrations/drivers";
import { mysqlMigrationLockName } from "@migrations/drivers/mysql/pinned-session";
import { inventoryLiveNamespace } from "@migrations/live-reset";
import { withLockedMigrationProducer } from "@migrations/pinned-session";
import { s } from "@schema";
import { createPool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const MYSQL_CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;
const describeIfMysql = MYSQL_CONNECTION ? describe : describe.skip;

const ALPHA = "viborm_pin_alpha";
const BETA = "viborm_pin_beta";

const estateSchema = (() => {
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
    })
    .map("pin_notes");
  return { note };
})();

// =============================================================================
// POSTGRESQL — one pool, two estates, one lock
// =============================================================================

describeIfPg("the pinned PostgreSQL session on a real server", () => {
  const admin = new PgDriver({ databaseUrl: PG_CONNECTION });

  function estateClient(namespace: string) {
    return createClient({
      schema: estateSchema,
      driver: new PgDriver({ databaseUrl: PG_CONNECTION, namespace }),
    });
  }

  beforeAll(async () => {
    for (const schema of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin._executeRaw(`CREATE SCHEMA "${schema}"`);
    }
  });

  afterAll(async () => {
    for (const schema of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin.disconnect();
  });

  it("holds one physical connection across a commit boundary", async () => {
    const driver = new PgDriver({
      databaseUrl: PG_CONNECTION,
      namespace: ALPHA,
    });
    try {
      const migrationDriver = getMigrationDriver(driver);
      const backendPids: unknown[] = [];
      const readPid = async (producer: AnyDriver) => {
        const result = await producer._executeRaw<{ pid: number }>(
          "SELECT pg_backend_pid() AS pid"
        );
        backendPids.push(result.rows[0]?.pid);
      };

      await withLockedMigrationProducer(
        driver,
        migrationDriver,
        async (pinned) => {
          await readPid(pinned);
          // A transaction opened inside the pinned body must run on the SAME
          // backend, not on a second pooled connection — otherwise the lock is
          // held by one connection and the work commits on another.
          await pinned.withTransaction(async (tx) => {
            await readPid(tx);
          });
          await readPid(pinned);
        }
      );

      expect(backendPids).toHaveLength(3);
      expect(new Set(backendPids).size).toBe(1);

      // The lock is gone: nothing is stranded on a pooled connection.
      const held = await admin._executeRaw<{ count: string }>(
        "SELECT count(*) AS count FROM pg_locks WHERE locktype = 'advisory'"
      );
      expect(Number(held.rows[0]?.count)).toBe(0);
    } finally {
      await driver.disconnect();
    }
  });

  it("makes a second same-database command wait for the first", async () => {
    const first = new PgDriver({
      databaseUrl: PG_CONNECTION,
      namespace: ALPHA,
    });
    const second = new PgDriver({
      databaseUrl: PG_CONNECTION,
      namespace: BETA,
    });
    try {
      const order: string[] = [];
      let releaseFirst: () => void = () => undefined;
      const firstHolds = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      let firstAcquired: () => void = () => undefined;
      const acquired = new Promise<void>((resolve) => {
        firstAcquired = resolve;
      });

      const firstRun = withLockedMigrationProducer(
        first,
        getMigrationDriver(first),
        async () => {
          order.push("first-acquired");
          firstAcquired();
          await firstHolds;
          order.push("first-releasing");
        }
      );

      await acquired;
      const secondRun = withLockedMigrationProducer(
        second,
        getMigrationDriver(second),
        () => {
          order.push("second-acquired");
          return Promise.resolve();
        }
      );

      // The key is database-wide, so two independent schema estates in one
      // database deliberately serialize with each other — they share a catalog.
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(order).toEqual(["first-acquired"]);

      releaseFirst();
      await Promise.all([firstRun, secondRun]);
      expect(order).toEqual([
        "first-acquired",
        "first-releasing",
        "second-acquired",
      ]);
    } finally {
      await first.disconnect();
      await second.disconnect();
    }
  });

  it("contains a force-reset inside one estate over a shared server", async () => {
    await syncLiveSchema(estateClient(ALPHA));
    await syncLiveSchema(estateClient(BETA));
    await admin._executeRaw(
      `INSERT INTO "${BETA}"."pin_notes" ("id", "body") VALUES ('sentinel', 'keep')`
    );

    await syncLiveSchema(estateClient(ALPHA), { forceReset: true });

    const alphaRows = await admin._executeRaw<{ count: string }>(
      `SELECT count(*) AS count FROM "${ALPHA}"."pin_notes"`
    );
    const betaRows = await admin._executeRaw<{ body: string }>(
      `SELECT "body" FROM "${BETA}"."pin_notes"`
    );
    expect(Number(alphaRows.rows[0]?.count)).toBe(0);
    // The sibling estate is byte-intact: the reset dropped and rebuilt only the
    // schema it was configured for, on a server both clients share.
    expect(betaRows.rows.map((row) => row.body)).toEqual(["keep"]);
  });

  it("refuses a cross-estate foreign key at the exact boundary", async () => {
    await admin._executeRaw(
      `ALTER TABLE "${BETA}"."pin_notes" ADD COLUMN "alpha_id" TEXT REFERENCES "${ALPHA}"."pin_notes"("id")`
    );
    try {
      await expect(syncLiveSchema(estateClient(ALPHA))).rejects.toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
      });
    } finally {
      await admin._executeRaw(
        `ALTER TABLE "${BETA}"."pin_notes" DROP COLUMN "alpha_id"`
      );
    }
  });
});

// =============================================================================
// MYSQL — GET_LOCK identity and attested reset containment
// =============================================================================

describeIfMysql("the pinned MySQL session on a real server", () => {
  const admin = new MySQL2Driver({
    databaseUrl: MYSQL_CONNECTION,
    migrationNamespaceAttestation: "non-redirecting",
  });

  function estateClient(namespace: string) {
    return createClient({
      schema: estateSchema,
      driver: new MySQL2Driver({
        databaseUrl: MYSQL_CONNECTION,
        namespace,
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });
  }

  beforeAll(async () => {
    for (const database of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin._executeRaw(`CREATE DATABASE \`${database}\``);
    }
  });

  afterAll(async () => {
    for (const database of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP DATABASE IF EXISTS \`${database}\``);
    }
    await admin.disconnect();
  });

  it("proves the lock, holds it on one connection, and releases it", async () => {
    const driver = new MySQL2Driver({
      databaseUrl: MYSQL_CONNECTION,
      namespace: ALPHA,
      migrationNamespaceAttestation: "non-redirecting",
    });
    try {
      const connectionIds: unknown[] = [];
      await withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async (pinned) => {
          for (let i = 0; i < 2; i += 1) {
            const result = await pinned._executeRaw<{ id: number }>(
              "SELECT CONNECTION_ID() AS id"
            );
            connectionIds.push(result.rows[0]?.id);
          }
          // The lock is genuinely held by THIS session.
          const held = await pinned._executeRaw<{ used: number | null }>(
            `SELECT IS_USED_LOCK(${JSON.stringify(mysqlMigrationLockName(ALPHA)).replace(/"/g, "'")}) AS used`
          );
          expect(held.rows[0]?.used).not.toBeNull();
        }
      );
      expect(new Set(connectionIds).size).toBe(1);

      // Released, and the connection destroyed rather than pooled: nobody else
      // can be holding it and no pooled connection carries session state.
      const free = await admin._executeRaw<{ free: number }>(
        `SELECT IS_FREE_LOCK(${JSON.stringify(mysqlMigrationLockName(ALPHA)).replace(/"/g, "'")}) AS free`
      );
      expect(Number(free.rows[0]?.free)).toBe(1);
    } finally {
      await driver.disconnect();
    }
  });

  it("gives two databases different lock names, so they do not block", async () => {
    const alpha = new MySQL2Driver({
      databaseUrl: MYSQL_CONNECTION,
      namespace: ALPHA,
      migrationNamespaceAttestation: "non-redirecting",
    });
    const beta = new MySQL2Driver({
      databaseUrl: MYSQL_CONNECTION,
      namespace: BETA,
      migrationNamespaceAttestation: "non-redirecting",
    });
    try {
      expect(mysqlMigrationLockName(ALPHA)).not.toBe(
        mysqlMigrationLockName(BETA)
      );
      let releaseAlpha: () => void = () => undefined;
      const alphaHolds = new Promise<void>((resolve) => {
        releaseAlpha = resolve;
      });
      const alphaRun = withLockedMigrationProducer(
        alpha,
        getMigrationDriver(alpha),
        () => alphaHolds
      );
      // Different database, different name: this must NOT wait.
      await withLockedMigrationProducer(beta, getMigrationDriver(beta), () =>
        Promise.resolve()
      );
      releaseAlpha();
      await alphaRun;
    } finally {
      await alpha.disconnect();
      await beta.disconnect();
    }
  });

  it("contains an attested reset inside its own database", async () => {
    await syncLiveSchema(estateClient(ALPHA));
    await syncLiveSchema(estateClient(BETA));
    await admin._executeRaw(
      `INSERT INTO \`${BETA}\`.\`pin_notes\` (\`id\`, \`body\`) VALUES ('sentinel', 'keep')`
    );

    await syncLiveSchema(estateClient(ALPHA), { forceReset: true });

    const alphaRows = await admin._executeRaw<{ count: number }>(
      `SELECT COUNT(*) AS count FROM \`${ALPHA}\`.\`pin_notes\``
    );
    const betaRows = await admin._executeRaw<{ body: string }>(
      `SELECT \`body\` FROM \`${BETA}\`.\`pin_notes\``
    );
    expect(Number(alphaRows.rows[0]?.count)).toBe(0);
    expect(betaRows.rows.map((row) => row.body)).toEqual(["keep"]);
  });

  it("runs a case-folded database on the server's OWN spelling", async () => {
    // The server has `viborm_pin_alpha`; this client is configured for
    // `VIBORM_PIN_ALPHA`. The catalog proof accepts the single case-folded
    // match (§5.2) — and before the resolved spelling was kept, everything
    // after it spoke the configured one: `USE` died with a raw
    // `ER_BAD_DB_ERROR: Unknown database`, and the reset inventory bound a
    // database this server does not have.
    //
    // The pool is SUPPLIED because a driver-created one defaults its own
    // `database` to the configured spelling, so on a case-sensitive server the
    // handshake fails before any migration statement — a connection fact, not
    // a migration one. §5.3 admits exactly this shape: a supplied pool plus an
    // explicit `namespace`.
    const pool = createPool({
      uri: MYSQL_CONNECTION,
      database: ALPHA,
    });
    const driver = new MySQL2Driver({
      pool,
      namespace: ALPHA.toUpperCase(),
      migrationNamespaceAttestation: "non-redirecting",
    });
    try {
      await admin._executeRaw(
        `CREATE TABLE IF NOT EXISTS \`${ALPHA}\`.\`pin_folded\` (\`id\` INT)`
      );
      const seen = await withLockedMigrationProducer(
        driver,
        getMigrationDriver(driver),
        async (pinned, command) => {
          const inventory = await inventoryLiveNamespace(pinned, command);
          const selected = await pinned._executeRaw<{ db: string }>(
            "SELECT DATABASE() AS db"
          );
          return { tables: inventory.tables, selected: selected.rows[0]?.db };
        }
      );

      // The session selected the database the server answered with…
      expect(seen.selected).toBe(ALPHA);
      // …and the inventory that decides what a reset DROPS read that same one.
      expect(seen.tables).toContain("pin_folded");
    } finally {
      await admin._executeRaw(
        `DROP TABLE IF EXISTS \`${ALPHA}\`.\`pin_folded\``
      );
      await driver.disconnect();
      // A supplied pool is the caller's to close, which is the whole point of
      // the distinction the driver draws.
      await pool.end();
    }
  });

  it("refuses an unattested effectful push before it drops anything", async () => {
    const unattested = new MySQL2Driver({
      databaseUrl: MYSQL_CONNECTION,
      namespace: BETA,
    });
    try {
      const client = createClient({ schema: estateSchema, driver: unattested });
      await expect(
        syncLiveSchema(client, { forceReset: true })
      ).rejects.toMatchObject({ code: VibORMErrorCode.DRIVER_NOT_SUPPORTED });

      // N6: MySQL reset used to be a no-op, so this command silently succeeded
      // and dropped nothing. It is real now, which is exactly why the refusal
      // has to happen before it runs.
      const betaRows = await admin._executeRaw<{ body: string }>(
        `SELECT \`body\` FROM \`${BETA}\`.\`pin_notes\``
      );
      expect(betaRows.rows.map((row) => row.body)).toEqual(["keep"]);
    } finally {
      await unattested.disconnect();
    }
  });
});
