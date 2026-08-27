/**
 * The PostgreSQL estate on a real server.
 *
 * PGlite proves the deterministic legs (`postgres-namespace.core.test.ts`) and
 * is the same engine, but it is one embedded session. A live server is where
 * the facts that only a server has show up: two connections from a pool, a
 * `search_path` that is genuinely session state, and a schema that another
 * client can be sitting in. Every control here is written against a decoy of
 * the same name in `public`, so a statement that lost its schema succeeds on
 * the wrong object rather than failing.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { MigrationError, VibORMErrorCode } from "@errors";
import { getMigrationDriver } from "@migrations/drivers";
import { introspect as introspectClient, push } from "@migrations/push";
import { PG, s } from "@schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIfDocker = CONNECTION_STRING ? describe : describe.skip;

const ESTATE_SCHEMA = "viborm_ns_estate";

const estateSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      state: s.enum(["active", "archived"]).name("nsd_account_state"),
      published: s.boolean(),
    })
    .map("nsd_accounts")
    .index(["email"], { where: "published = true" });
  return { account };
})();

function clientFor(namespace: string) {
  return createClient({
    schema: estateSchema,
    driver: new PgDriver({ databaseUrl: CONNECTION_STRING, namespace }),
  });
}

describeIfDocker("PostgreSQL estate containment (docker)", () => {
  const admin = new PgDriver({ databaseUrl: CONNECTION_STRING });

  beforeAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${ESTATE_SCHEMA}" CASCADE`);
    await admin._executeRaw('DROP TABLE IF EXISTS "nsd_accounts" CASCADE');
    await admin._executeRaw('DROP TYPE IF EXISTS "nsd_account_state" CASCADE');
    await admin._executeRaw(`CREATE SCHEMA "${ESTATE_SCHEMA}"`);
    // Decoys in `public`, identically named.
    await admin._executeRaw(
      'CREATE TABLE "nsd_accounts" ("id" TEXT PRIMARY KEY, "decoy" TEXT)'
    );
    await admin._executeRaw(
      `CREATE TYPE "nsd_account_state" AS ENUM ('decoy')`
    );
  });

  afterAll(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${ESTATE_SCHEMA}" CASCADE`);
    await admin._executeRaw('DROP TABLE IF EXISTS "nsd_accounts" CASCADE');
    await admin._executeRaw('DROP TYPE IF EXISTS "nsd_account_state" CASCADE');
    await admin.disconnect();
  });

  it("pushes into its own schema and converges on the second push", async () => {
    const client = clientFor(ESTATE_SCHEMA);
    try {
      const first = await push(client, { force: true });
      expect(first.operations.length).toBeGreaterThan(0);

      // Second push is empty: the enum default (`'active'::schema.enum`) and
      // the deparsed partial-index predicate both canonicalize against THIS
      // schema, and the canonicalizer's scratch view names it too.
      const second = await push(client, { force: true });
      expect(second.operations).toEqual([]);

      const decoy = await admin._executeRaw<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'nsd_accounts' ORDER BY column_name"
      );
      expect(decoy.rows.map((row) => row.column_name)).toEqual(["decoy", "id"]);
    } finally {
      await client.$disconnect();
    }
  });

  it("tracks migrations in its own schema, on a pooled connection", async () => {
    const client = clientFor(ESTATE_SCHEMA);
    try {
      const migrationDriver = getMigrationDriver(client.$driver);
      // A pool hands out a different connection per statement, so a tracking
      // table reached through an ambient `search_path` is a coin flip. Every
      // statement below names the schema.
      await client.$driver._executeRaw(
        migrationDriver.generateCreateTrackingTable("_viborm_migrations")
      );
      const insert =
        migrationDriver.generateInsertMigration("_viborm_migrations");
      await client.$driver._executeRaw(insert.sql, ["init", "checksum"]);
      const applied = await client.$driver._executeRaw<{ name: string }>(
        migrationDriver.generateSelectAppliedMigrations("_viborm_migrations")
      );
      expect(applied.rows.map((row) => row.name)).toEqual(["init"]);

      const located = await admin._executeRaw<{ table_schema: string }>(
        "SELECT table_schema FROM information_schema.tables WHERE table_name = '_viborm_migrations'"
      );
      expect(located.rows.map((row) => row.table_schema)).toEqual([
        ESTATE_SCHEMA,
      ]);
    } finally {
      await client.$disconnect();
    }
  });

  it("refuses a configured schema the server does not have", async () => {
    const client = clientFor("viborm_ns_absent");
    try {
      const failure = await introspectClient(client).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toBeInstanceOf(MigrationError);
      expect(failure).toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      });
      expect(String(failure)).toContain("viborm_ns_absent");
    } finally {
      await client.$disconnect();
    }
  });

  it("is unaffected by a session search_path that names the decoys", async () => {
    const client = clientFor(ESTATE_SCHEMA);
    try {
      // `search_path` is the mechanism this feature refuses to depend on. With
      // `public` first, an unqualified statement resolves to the decoy table.
      // (On a pool this reaches one connection, which is exactly the point:
      // correctness cannot depend on which connection answered.)
      await client.$driver._executeRaw("SET search_path TO public");
      const snapshot = await introspectClient(client);

      const account = snapshot.tables.find(
        (table) => table.name === "nsd_accounts"
      );
      const columns = account?.columns.map((column) => column.name);
      expect(columns).toContain("email");
      // The decoy's own column, which introspection would report if the
      // catalog filter had drifted to `public`.
      expect(columns).not.toContain("decoy");
      // The estate's tables are its own — the tracking table above included —
      // and `public` contributes nothing to the snapshot.
      expect(snapshot.tables.map((table) => table.name).sort()).toEqual([
        "_viborm_migrations",
        "nsd_accounts",
      ]);
    } finally {
      await client.$disconnect();
    }
  });
});

const CITEXT_SCHEMA = "viborm_ns_citext";

const contactSchema = (() => {
  const contact = s
    .model({
      id: s.string().id(),
      email: s.string(PG.STRING.CITEXT),
    })
    .map("nsd_contacts");
  return { contact };
})();

/**
 * A real extension, on a real server, that no driver capability admits.
 *
 * PGlite proves the same round trip deterministically, but only a server can
 * be asked to install `citext` the way a user's database has it: owned by
 * `public`, resolved by `search_path` for the DDL's unqualified type token,
 * and reported through `pg_depend`/`pg_extension` by the server's own catalog
 * rather than by a fixture's idea of one.
 */
describeIfDocker("PostgreSQL extension types (docker)", () => {
  const admin = new PgDriver({ databaseUrl: CONNECTION_STRING });
  let installedCitext = false;

  beforeAll(async () => {
    // Never drop an extension this suite did not install: the test database is
    // shared, and `citext` may be somebody else's fixture.
    const present = await admin._executeRaw<{ present: number }>(
      "SELECT 1 AS present FROM pg_catalog.pg_extension WHERE extname = 'citext'"
    );
    if (present.rows.length === 0) {
      await admin._executeRaw("CREATE EXTENSION citext");
      installedCitext = true;
    }
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${CITEXT_SCHEMA}" CASCADE`);
    await admin._executeRaw(`CREATE SCHEMA "${CITEXT_SCHEMA}"`);
  });

  afterAll(async () => {
    // The schema goes first: its citext columns depend on the extension.
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${CITEXT_SCHEMA}" CASCADE`);
    if (installedCitext) {
      await admin._executeRaw("DROP EXTENSION IF EXISTS citext");
    }
    await admin.disconnect();
  });

  it("pushes, reads back and converges on a type no capability admits", async () => {
    const client = createClient({
      schema: contactSchema,
      driver: new PgDriver({
        databaseUrl: CONNECTION_STRING,
        namespace: CITEXT_SCHEMA,
      }),
    });
    try {
      const first = await push(client, { force: true });
      expect(first.operations.length).toBeGreaterThan(0);

      // The server stored the extension's type; the read-back spells it the
      // way the desired side does, so the second push plans nothing. Refusing
      // the type instead would leave this estate pushed once and unreadable.
      const stored = await admin._executeRaw<{ udt_name: string }>(
        "SELECT udt_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'nsd_contacts' AND column_name = 'email'",
        [CITEXT_SCHEMA]
      );
      expect(stored.rows.map((row) => row.udt_name)).toEqual(["citext"]);

      const snapshot = await introspectClient(client);
      const contact = snapshot.tables.find(
        (table) => table.name === "nsd_contacts"
      );
      expect(
        contact?.columns.find((column) => column.name === "email")?.type
      ).toBe("citext");

      const second = await push(client, { force: true });
      expect(second.operations).toEqual([]);
    } finally {
      await client.$disconnect();
    }
  });
});
