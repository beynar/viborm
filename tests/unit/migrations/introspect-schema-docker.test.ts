/**
 * `introspectSchema` on a real PostgreSQL server: the same contract as the
 * PGlite lane, each test on a database of its own, and the `url` entry, which
 * opens its own connection and must always close it.
 *
 * Run locally with:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { PgDriver } from "@drivers/pg";
import { introspectSchema } from "@migrations/introspect";
import { afterAll, describe, expect, it } from "vitest";
import {
  RICH_POSTGRES_SQL,
  RICH_SKIPPED_SQL,
  RICH_TABLES,
} from "./_introspect-fixtures";
import { postgresIntrospectionSuite } from "./_introspect-postgres-suite";

const CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIfDocker = CONNECTION_STRING ? describe : describe.skip;

const created: string[] = [];
const opened: PgDriver[] = [];

function urlFor(database: string): string {
  const url = new URL(CONNECTION_STRING!);
  url.pathname = `/${database}`;
  return url.href;
}

async function freshDatabase(): Promise<string> {
  const name = `viborm_introspect_${process.pid}_${created.length}`;
  const admin = new PgDriver({ databaseUrl: CONNECTION_STRING });
  try {
    await admin._executeRaw(`DROP DATABASE IF EXISTS "${name}"`, []);
    await admin._executeRaw(`CREATE DATABASE "${name}"`, []);
  } finally {
    await admin.disconnect();
  }
  created.push(name);
  return name;
}

describeIfDocker("introspectSchema on PostgreSQL (docker)", () => {
  afterAll(async () => {
    for (const driver of opened) await driver.disconnect();
    const admin = new PgDriver({ databaseUrl: CONNECTION_STRING });
    try {
      for (const name of created)
        await admin._executeRaw(
          `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`,
          []
        );
    } finally {
      await admin.disconnect();
    }
  });

  postgresIntrospectionSuite({
    async fresh() {
      const driver = new PgDriver({
        databaseUrl: urlFor(await freshDatabase()),
      });
      opened.push(driver);
      return driver;
    },
  });

  it("reads a URL, closes its connection, and says what it skipped", async () => {
    const name = await freshDatabase();
    const setup = new PgDriver({ databaseUrl: urlFor(name) });
    try {
      for (const statement of [...RICH_POSTGRES_SQL, ...RICH_SKIPPED_SQL])
        await setup._executeRaw(statement, []);
    } finally {
      await setup.disconnect();
    }
    const scoped = await introspectSchema({
      url: urlFor(name),
      tables: RICH_TABLES,
    });
    expect(scoped.dialect).toBe("postgresql");
    expect(
      scoped.warnings.filter((warning) => warning.kind === "drift")
    ).toEqual([]);
    const all = await introspectSchema({ url: urlFor(name) });
    expect(all.document).toEqual(scoped.document);
    expect(all.skipped.map((item) => item.name)).toEqual(
      expect.arrayContaining([
        "audit_log",
        "account_emails",
        "ledger",
        "account_email_shape",
      ])
    );
    const probe = new PgDriver({ databaseUrl: CONNECTION_STRING });
    try {
      const sessions = await probe._executeRaw<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_stat_activity WHERE datname = $1",
        [name]
      );
      expect(sessions.rows[0]?.count).toBe("0");
    } finally {
      await probe.disconnect();
    }
  });
});
