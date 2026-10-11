/**
 * The PostgreSQL catalog digest (plan D5, decision 7) against a real server:
 * for every schema of the corpus, pushed into a schema of its own, the
 * one-statement digest equals `fingerprintLive` of a full introspection,
 * before and after the catalog drifts. PGlite proves the same corpus in
 * `postgres-catalog-digest.test.ts`; a server's catalog, collation and
 * deparser are what this file adds. A no-op apply proven by the digest
 * before the lock still waits for a command that holds the lock (plan D5).
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import { setTimeout as delay } from "node:timers/promises";
import { createClient } from "@drivers/pg";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { s } from "@schema";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  catalogDigestCorpus,
  digestAndFingerprint,
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
});
