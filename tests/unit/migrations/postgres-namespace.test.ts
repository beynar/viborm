/** Live PGlite convergence for PostgreSQL migration namespaces. */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { vector } from "@electric-sql/pglite/vector";
import { MigrationError, VibORMErrorCode } from "@errors";
import { introspect as introspectClient } from "@migrations/push";
import { PG, s } from "@schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";

const CROSS_SCHEMA_TOPOLOGY = /unsupported migration topology/;

// =============================================================================
// CONVERGENCE ON A REAL SERVER (PGlite)
// =============================================================================

const tenantSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      email: s.string().unique(),
      state: s.enum(["active", "archived"]).name("account_state"),
      published: s.boolean(),
    })
    .map("ns_accounts")
    .index(["email"], { where: "published = true" });
  return { account };
})();

let database: PGlite;

async function pushInto(namespace: string) {
  const client = createClient({
    schema: tenantSchema,
    driver: new PGliteDriver({ client: database, namespace }),
  });
  return await syncLiveSchema(client);
}

describe("a custom schema converges on PostgreSQL", () => {
  beforeAll(async () => {
    database = new PGlite();
    await database.exec('CREATE SCHEMA "billing"');
    // Decoys in `public`, identically named: an unqualified statement finds
    // them and succeeds on the wrong object instead of failing.
    await database.exec(
      'CREATE TABLE "ns_accounts" ("id" TEXT PRIMARY KEY, "decoy" TEXT)'
    );
    await database.exec(`CREATE TYPE "account_state" AS ENUM ('decoy')`);
  });

  afterAll(async () => {
    await database?.close();
  });

  it("creates only its own objects, then plans nothing", async () => {
    const first = await pushInto("billing");
    expect(first.operations.length).toBeGreaterThan(0);

    // The public decoys are untouched: same names, different schema.
    const decoyColumns = await database.query<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'ns_accounts'"
    );
    expect(decoyColumns.rows.map((row) => row.column_name).sort()).toEqual([
      "decoy",
      "id",
    ]);
    const decoyEnum = await database.query<{ enumlabel: string }>(
      "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' AND t.typname = 'account_state'"
    );
    expect(decoyEnum.rows.map((row) => row.enumlabel)).toEqual(["decoy"]);

    // The estate's own objects exist where they were asked for.
    const created = await database.query<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'billing'"
    );
    expect(created.rows.map((row) => row.table_name)).toEqual(["ns_accounts"]);

    // Second push is empty: the enum default and the partial-index predicate
    // both canonicalize against the estate's schema, not the decoy's.
    const second = await pushInto("billing");
    expect(second.operations).toEqual([]);
  });

  it("reads its own schema back and nothing else's", async () => {
    const client = createClient({
      schema: tenantSchema,
      driver: new PGliteDriver({ client: database, namespace: "billing" }),
    });
    const snapshot = await introspectClient(client);

    expect(snapshot.tables.map((table) => table.name)).toEqual(["ns_accounts"]);
    // Namespace-RELATIVE in the other direction: the snapshot carries bare
    // names, so it is the schema the DDL renderer qualifies with, not the
    // snapshot, that binds an estate.
    expect(snapshot.enums?.map((definition) => definition.name)).toEqual([
      "account_state",
    ]);
    expect(JSON.stringify(snapshot)).not.toContain("billing");
  });

  it("refuses a schema that does not exist, before any DDL", async () => {
    const failure = await pushInto("absent_tenant").then(
      () => undefined,
      (error: unknown) => error
    );

    expect(failure).toBeInstanceOf(MigrationError);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
    });
    // A missing schema is not an empty database: nothing was created for it.
    const leaked = await database.query<{ nspname: string }>(
      "SELECT nspname FROM pg_namespace WHERE nspname = 'absent_tenant'"
    );
    expect(leaked.rows).toEqual([]);
  });

  it("refuses an inbound foreign key from outside the estate", async () => {
    await database.exec(
      'CREATE TABLE "public"."ns_watchers" ("id" TEXT PRIMARY KEY, "account_id" TEXT REFERENCES "billing"."ns_accounts"("id"))'
    );
    try {
      await expect(pushInto("billing")).rejects.toThrow(CROSS_SCHEMA_TOPOLOGY);
    } finally {
      await database.exec('DROP TABLE "public"."ns_watchers"');
    }
  });
});

// =============================================================================
// EXTENSION TYPES ON A REAL SERVER (PGlite + pgvector)
// =============================================================================

const embeddingSchema = (() => {
  const point = s
    .model({
      id: s.string().id(),
      embedding: s.vector().dimension(3),
    })
    .map("ns_points");
  return { point };
})();

describe("an extension type converges inside a custom schema", () => {
  let vectorDatabase: PGlite;

  beforeAll(async () => {
    vectorDatabase = new PGlite({ extensions: { vector } });
    // The extension lives in `public`; the estate lives elsewhere. This is the
    // shape §4.2 describes — a provider object owned by another schema, which
    // the estate uses without managing.
    await vectorDatabase.exec("CREATE EXTENSION IF NOT EXISTS vector");
    await vectorDatabase.exec('CREATE SCHEMA "tenant_v"');
  });

  afterAll(async () => {
    await vectorDatabase?.close();
  });

  it("keeps vector(3) through a first push, a read-back and a second push", async () => {
    const client = createClient({
      schema: embeddingSchema,
      driver: new PGliteDriver({
        client: vectorDatabase,
        namespace: "tenant_v",
        pgvector: true,
      }),
    });

    const first = await syncLiveSchema(client);
    expect(first.operations.length).toBeGreaterThan(0);

    // The typmod survives the catalog round-trip. Reduced to `udt_name` it
    // reads back as a bare `vector`, and every later push re-alters the column.
    const snapshot = await introspectClient(client);
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toContain(
      "vector(3)"
    );

    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });

  it("reads the same column through udt_name when the driver declares no vector support", async () => {
    const unaware = createClient({
      schema: embeddingSchema,
      driver: new PGliteDriver({
        client: vectorDatabase,
        namespace: "tenant_v",
      }),
    });

    const snapshot = await introspectClient(unaware);
    const types = snapshot.tables
      .find((table) => table.name === "ns_points")
      ?.columns.map((column) => column.type);

    // Not a refusal — the column is still representable, and this is the
    // reading every snapshot written before `format_type` was consulted holds.
    // What the missing capability costs is the typmod: `vector`, not
    // `vector(3)`, which is the churn N4 fixed for a driver that DOES declare
    // the extension.
    expect(types).toContain("vector");
    expect(types).not.toContain("vector(3)");
  });
});

// =============================================================================
// AN EXTENSION TYPE NO CAPABILITY ADMITS (PGlite + citext)
// =============================================================================

const contactSchema = (() => {
  const contact = s
    .model({
      id: s.string().id(),
      // A shipped VibORM native type whose extension no driver capability
      // declares. Before the fall-through this pair of pushes could not be
      // written: the first push succeeded and every later read refused.
      email: s.string(PG.STRING.CITEXT),
    })
    .map("ns_contacts");
  return { contact };
})();

describe("an extension type no capability admits converges in a custom schema", () => {
  let citextDatabase: PGlite;

  beforeAll(async () => {
    citextDatabase = new PGlite({ extensions: { citext } });
    // The extension lives in `public` — where `CREATE EXTENSION` puts it and
    // where the estate's own unqualified `citext` type token resolves it — and
    // the estate lives elsewhere, so the type is external in exactly the way
    // §4.2 means.
    await citextDatabase.exec("CREATE EXTENSION IF NOT EXISTS citext");
    await citextDatabase.exec('CREATE SCHEMA "tenant_c"');
  });

  afterAll(async () => {
    await citextDatabase?.close();
  });

  it("keeps citext through a first push, a read-back and a second push", async () => {
    const client = createClient({
      schema: contactSchema,
      driver: new PGliteDriver({
        client: citextDatabase,
        namespace: "tenant_c",
      }),
    });

    const first = await syncLiveSchema(client);
    expect(first.operations.length).toBeGreaterThan(0);

    const snapshot = await introspectClient(client);
    expect(snapshot.tables[0]?.columns.map((column) => column.type)).toContain(
      "citext"
    );

    // The whole point: the read-back spelling equals the desired spelling, so
    // the estate converges instead of refusing forever after its first push.
    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });
});

describe("a unique-index foreign-key target stays visible", () => {
  const host = s
    .model({
      id: s.int().id(),
      code: s.string(),
      pets: s.toMany(() => pet),
    })
    .map("ns_hosts")
    .index(["code"], { unique: true });
  const pet = s
    .model({
      id: s.int().id(),
      hostCode: s.string(),
      host: s
        .toOne(() => host)
        .fields("hostCode")
        .references("code")
        .onUpdate("cascade"),
    })
    .map("ns_pets");
  const schema = { host, pet };
  let uniqueIndexDatabase: PGlite;

  beforeAll(async () => {
    uniqueIndexDatabase = new PGlite();
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: uniqueIndexDatabase }),
    });
    await syncLiveSchema(client);
  });

  afterAll(async () => {
    await uniqueIndexDatabase?.close();
  });

  it("reads the unique index and the foreign key that targets it", async () => {
    const client = createClient({
      schema,
      driver: new PGliteDriver({ client: uniqueIndexDatabase }),
    });
    const snapshot = await introspectClient(client);
    const hosts = snapshot.tables.find((table) => table.name === "ns_hosts");
    const pets = snapshot.tables.find((table) => table.name === "ns_pets");

    expect(hosts?.indexes).toEqual([
      expect.objectContaining({
        name: "ns_hosts_code_idx",
        columns: ["code"],
        unique: true,
      }),
    ]);
    expect(hosts?.uniqueConstraints).toEqual([]);
    expect(pets?.foreignKeys).toEqual([
      expect.objectContaining({
        name: "ns_pets_hostCode_fkey",
        columns: ["hostCode"],
        referencedTable: "ns_hosts",
        referencedColumns: ["code"],
        onUpdate: "cascade",
      }),
    ]);

    const second = await syncLiveSchema(client);
    expect(second.operations).toEqual([]);
  });
});
