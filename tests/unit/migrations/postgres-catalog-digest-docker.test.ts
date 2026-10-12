/**
 * The PostgreSQL catalog digest (plan D5, decision 7) against a real server:
 * for every schema of the corpus, pushed into a schema of its own, the
 * one-statement digest equals `fingerprintLive` of a full introspection,
 * before and after the catalog drifts. PGlite proves the same corpus in
 * `postgres-catalog-digest.test.ts`; a server's catalog, collation and
 * deparser are what this file adds. A no-op apply proven by the digest
 * before the lock still waits for a command that holds the lock (plan D5),
 * and covers a soft-delete estate's partial indexes through the server's own
 * deparse, recorded beside the marker.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  catalogDigestCorpus,
  digestAndFingerprint,
  softDeleteAccounts,
} from "./_catalog-digest-corpus";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;
/** `MIGRATION_LOCK_ID` of `pinned-session.ts`: "viborm" in hex, truncated. */
const MIGRATION_LOCK_ID = 0x76_69_62_6f_72_6d;

describeIfPg("the catalog digest on PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: PG_CONNECTION });
  const namespaces: string[] = [];

  beforeAll(() => admin.connect());
  afterAll(async () => {
    for (const namespace of namespaces) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await admin.end();
  });

  for (const [index, item] of catalogDigestCorpus.entries()) {
    it(item.id, async () => {
      const namespace = `viborm_digest_${index}`;
      namespaces.push(namespace);
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${namespace}"`);
      const orm = createClient({
        schema: item.build(),
        databaseUrl: PG_CONNECTION,
        namespace,
        options: { max: 1 },
      });
      try {
        await createMigrationClient(orm).push();
        const pushed = await digestAndFingerprint(orm);
        expect(pushed.digest).toBe(pushed.fingerprint);

        for (const statement of item.drift) {
          await admin.query(statement.replaceAll("{ns}", namespace));
        }
        const drifted = await digestAndFingerprint(orm);
        expect(drifted.digest).toBe(drifted.fingerprint);
      } finally {
        await orm.$disconnect();
      }
    });
  }

  it("a no-op apply waits for a command that holds the migration lock", async () => {
    const namespace = "viborm_digest_locked";
    namespaces.push(namespace);
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    const orm = createClient({
      schema: { account: s.model({ id: s.string().id() }).map("accounts") },
      databaseUrl: PG_CONNECTION,
      namespace,
      options: { max: 1 },
    });
    const holder = new pg.Client({ connectionString: PG_CONNECTION });
    try {
      const migrations = createMigrationClient(orm, {
        storage: new MemoryEstateStorage(),
      });
      await migrations.generate({ name: "base" });
      await migrations.apply();

      await holder.connect();
      await holder.query("BEGIN");
      await holder.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`);
      const noop = migrations.apply().then(({ outcome }) => outcome);
      const meanwhile = await Promise.race([
        noop,
        delay(500).then(() => "waiting"),
      ]);
      await holder.query("COMMIT");

      expect(meanwhile).toBe("waiting");
      expect(await noop).toBe("noop");
    } finally {
      await holder.end();
      await orm.$disconnect();
    }
  });

  it("a soft-delete estate's no-op is proven in at most 3 statements, and a predicate alone can drift", async () => {
    const namespace = "viborm_digest_soft_delete";
    namespaces.push(namespace);
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    const orm = createClient({
      schema: softDeleteAccounts(),
      databaseUrl: PG_CONNECTION,
      namespace,
      options: { max: 1 },
    });
    const migrations = createMigrationClient(orm, {
      storage: new MemoryEstateStorage(),
    });
    const sent = vi.spyOn(pg.Client.prototype, "query");
    const recreate = (predicate: string) =>
      admin.query(
        `DROP INDEX "${namespace}"."accounts_live_email";
         CREATE UNIQUE INDEX "accounts_live_email" ON "${namespace}"."accounts" ("email") WHERE ${predicate}`
      );
    try {
      await migrations.generate({ name: "base" });
      await migrations.apply();
      await admin.query(
        `INSERT INTO "${namespace}"."accounts" ("id", "email", "deletedAt")
         SELECT 'acct-' || g, 'user' || (g % 9000) || '@example.com', CASE WHEN g > 9000 THEN now() END
         FROM generate_series(1, 10000) g`
      );

      sent.mockClear();
      expect((await migrations.apply()).outcome).toBe("noop");
      expect(sent.mock.calls.length).toBeLessThanOrEqual(3);

      await recreate(`"deletedAt" IS NOT NULL`);
      await expect(migrations.apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DRIFT,
      });
      await recreate(`(("deletedAt") IS NULL)`);
      sent.mockClear();
      expect((await migrations.apply()).outcome).toBe("noop");
      expect(sent.mock.calls.length).toBeLessThanOrEqual(3);
    } finally {
      sent.mockRestore();
      await orm.$disconnect();
    }
  });

  it("a BETWEEN inside an AND is the same predicate live as declared: the first apply proves it", async () => {
    const namespace = "viborm_digest_between";
    namespaces.push(namespace);
    await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await admin.query(`CREATE SCHEMA "${namespace}"`);
    const orm = createClient({
      schema: {
        person: s
          .model({ id: s.string().id(), age: s.int(), country: s.string() })
          .index(["age"], {
            name: "p_band",
            where: `"age" BETWEEN 18 AND 65 AND "country" IN ('FR', 'DE')`,
          }),
      },
      databaseUrl: PG_CONNECTION,
      namespace,
      options: { max: 1 },
    });
    const migrations = createMigrationClient(orm, {
      storage: new MemoryEstateStorage(),
    });
    try {
      await migrations.generate({ name: "band" });
      expect((await migrations.apply()).outcome).toBe("applied");
      expect((await migrations.apply()).outcome).toBe("noop");
      expect(await migrations.verify()).toMatchObject({ ok: true });
    } finally {
      await orm.$disconnect();
    }
  });
});
