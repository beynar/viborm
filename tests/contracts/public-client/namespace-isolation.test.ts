/**
 * Provider lane: two clients, one connection, two PostgreSQL schemas.
 *
 * Qualification is the whole containment mechanism: nothing sets `search_path`
 * and nothing issues `USE`, so a client reaches its own namespace only because
 * every persistent table it names carries that namespace. The decoy schemas
 * below hold IDENTICALLY NAMED tables, so any statement that lost its prefix —
 * or that a hostile `search_path` could redirect — reads or writes the wrong
 * rows instead of failing loudly.
 *
 * The provider is PGlite: one database, one session, shared by both clients.
 * The docker PostgreSQL and MySQL legs live in the provider acceptance unit.
 */

import { createClient } from "@client/client";
import { PGliteDriver } from "@drivers/pglite";
import { PGlite } from "@electric-sql/pglite";
import { defineExtension } from "@extensions";
import { s } from "@schema";
import type { Sql } from "@sql";
import { BatchOnlyPGliteDriver } from "@tests/fixtures/drivers/pglite";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

const isolationSchema = (() => {
  const account = s
    .model({
      id: s.string().id(),
      label: s.string(),
    })
    .map("ns_accounts");
  return { account };
})();

const TENANTS = ["tenant_a", "tenant_b"] as const;
type Tenant = (typeof TENANTS)[number];

let database: PGlite;
const clients = new Map<
  Tenant,
  ReturnType<typeof createClient<typeof isolationSchema, never>>
>();

/**
 * The same two tenants over the BATCH-ONLY substrate.
 *
 * `BatchOnlyPGliteDriver` is the repo's atomic-batch fixture: it declares
 * `supportsTransactions = false` and `supportsBatch = true`, so an array
 * `$transaction` is prepared and submitted as ONE native batch instead of being
 * replayed statement by statement inside a provider transaction. That is the
 * only execution surface the transaction-shaped cases below never reach.
 */
interface BatchTenant {
  readonly driver: BatchOnlyPGliteDriver;
  readonly client: ReturnType<
    typeof createClient<typeof isolationSchema, never>
  >;
}
const batchTenants = new Map<Tenant, BatchTenant>();

const clientFor = (tenant: Tenant) => {
  const client = clients.get(tenant);
  if (!client) throw new Error(`no client for ${tenant}`);
  return client;
};

const batchTenantFor = (tenant: Tenant): BatchTenant => {
  const batch = batchTenants.get(tenant);
  if (!batch) throw new Error(`no batch client for ${tenant}`);
  return batch;
};

beforeAll(async () => {
  database = new PGlite();
  // `public` holds a decoy of the same shape: an unqualified statement would
  // find a table rather than fail.
  await database.exec(
    'CREATE TABLE "ns_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)'
  );
  for (const tenant of TENANTS) {
    await database.exec(`CREATE SCHEMA "${tenant}"`);
    await database.exec(
      `CREATE TABLE "${tenant}"."ns_accounts" ("id" TEXT PRIMARY KEY, "label" TEXT NOT NULL)`
    );
  }
  for (const tenant of TENANTS) {
    clients.set(
      tenant,
      createClient({
        schema: isolationSchema,
        driver: new PGliteDriver({ client: database, namespace: tenant }),
      })
    );
    const batchDriver = new BatchOnlyPGliteDriver({
      client: database,
      namespace: tenant,
    });
    batchTenants.set(tenant, {
      driver: batchDriver,
      client: createClient({ schema: isolationSchema, driver: batchDriver }),
    });
  }
});

beforeEach(async () => {
  await database.exec("SET search_path TO public");
  await database.exec('TRUNCATE TABLE "ns_accounts"');
  for (const tenant of TENANTS) {
    await database.exec(`TRUNCATE TABLE "${tenant}"."ns_accounts"`);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  // The database is supplied, so this suite — not any driver — owns it.
  clients.clear();
  batchTenants.clear();
  await database.close();
});

const rowsIn = async (schemaName: string) =>
  (
    await database.query<{ id: string; label: string }>(
      `SELECT "id", "label" FROM "${schemaName}"."ns_accounts" ORDER BY "id"`
    )
  ).rows;

describe("two clients over one connection cannot cross", () => {
  test("interleaved writes land in each client's own schema", async () => {
    const a = clientFor("tenant_a");
    const b = clientFor("tenant_b");

    await a.account.create({ data: { id: "1", label: "a-one" } });
    await b.account.create({ data: { id: "1", label: "b-one" } });
    await a.account.create({ data: { id: "2", label: "a-two" } });
    await b.account.update({ where: { id: "1" }, data: { label: "b-edit" } });

    expect(await rowsIn("tenant_a")).toEqual([
      { id: "1", label: "a-one" },
      { id: "2", label: "a-two" },
    ]);
    expect(await rowsIn("tenant_b")).toEqual([{ id: "1", label: "b-edit" }]);
    expect(await rowsIn("public")).toEqual([]);
  });

  test("interleaved reads see only each client's own rows", async () => {
    const a = clientFor("tenant_a");
    const b = clientFor("tenant_b");
    await a.account.createMany({
      data: [
        { id: "1", label: "a-one" },
        { id: "2", label: "a-two" },
      ],
    });
    await b.account.create({ data: { id: "3", label: "b-three" } });

    await expect(
      a.account.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: "1", label: "a-one" },
      { id: "2", label: "a-two" },
    ]);
    await expect(b.account.findMany()).resolves.toEqual([
      { id: "3", label: "b-three" },
    ]);
    await expect(
      a.account.findUnique({ where: { id: "3" } })
    ).resolves.toBeNull();
    await expect(b.account.count()).resolves.toBe(1);
  });

  test("a delete in one schema leaves the other's identically keyed row", async () => {
    const a = clientFor("tenant_a");
    const b = clientFor("tenant_b");
    await a.account.create({ data: { id: "1", label: "a-one" } });
    await b.account.create({ data: { id: "1", label: "b-one" } });

    await a.account.delete({ where: { id: "1" } });

    expect(await rowsIn("tenant_a")).toEqual([]);
    expect(await rowsIn("tenant_b")).toEqual([{ id: "1", label: "b-one" }]);
  });
});

describe("a hostile search_path cannot redirect ORM tables", () => {
  test("reads and writes still reach the configured schema", async () => {
    const a = clientFor("tenant_a");
    await a.account.create({ data: { id: "1", label: "a-one" } });

    // Point the session at the sibling tenant, whose table has the same name.
    await database.exec("SET search_path TO tenant_b, public");

    await a.account.create({ data: { id: "2", label: "a-two" } });
    await expect(
      a.account.findMany({ orderBy: { id: "asc" } })
    ).resolves.toEqual([
      { id: "1", label: "a-one" },
      { id: "2", label: "a-two" },
    ]);
    expect(await rowsIn("tenant_b")).toEqual([]);
    expect(await rowsIn("public")).toEqual([]);
  });

  test("caller-owned raw SQL is NOT rewritten and follows the search_path", async () => {
    const a = clientFor("tenant_a");
    await database.exec("SET search_path TO tenant_b, public");
    await database.exec(
      `INSERT INTO "tenant_b"."ns_accounts" VALUES ('9', 'b-nine')`
    );

    // Unqualified raw text resolves through the session's own search_path,
    // which is exactly what "raw SQL remains caller-owned" means.
    await expect(
      a.$queryRawUnsafe('SELECT "label" FROM "ns_accounts"')
    ).resolves.toEqual([{ label: "b-nine" }]);
    await expect(
      a.$queryRaw<{ label: string }>`SELECT "label" FROM "ns_accounts"`
    ).resolves.toEqual([{ label: "b-nine" }]);
  });
});

describe("every execution surface keeps the same target", () => {
  test("callback transactions and their nested scopes", async () => {
    const a = clientFor("tenant_a");
    await a.$transaction(async (tx) => {
      await tx.account.create({ data: { id: "1", label: "a-one" } });
      await tx.$transaction(async (nested) => {
        await nested.account.create({ data: { id: "2", label: "a-two" } });
      });
    });

    expect(await rowsIn("tenant_a")).toEqual([
      { id: "1", label: "a-one" },
      { id: "2", label: "a-two" },
    ]);
    expect(await rowsIn("public")).toEqual([]);
  });

  test("array transactions", async () => {
    const a = clientFor("tenant_a");
    await a.$transaction([
      a.account.create({ data: { id: "1", label: "a-one" } }),
      a.account.create({ data: { id: "2", label: "a-two" } }),
    ]);

    expect(await rowsIn("tenant_a")).toHaveLength(2);
    expect(await rowsIn("public")).toEqual([]);
  });

  test("a rolled-back transaction touches no sibling schema", async () => {
    const a = clientFor("tenant_a");
    const b = clientFor("tenant_b");
    await b.account.create({ data: { id: "1", label: "b-one" } });

    await expect(
      a.$transaction(async (tx) => {
        await tx.account.create({ data: { id: "1", label: "a-one" } });
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");

    expect(await rowsIn("tenant_a")).toEqual([]);
    expect(await rowsIn("tenant_b")).toEqual([{ id: "1", label: "b-one" }]);
  });
});

describe("a native atomic batch keeps the adapter's target", () => {
  test("every statement one submitted batch carries names the client's own schema", async () => {
    const a = batchTenantFor("tenant_a");
    const b = clientFor("tenant_b");
    await b.account.create({ data: { id: "1", label: "b-one" } });

    const executeBatch = vi.spyOn(a.driver, "_executeBatch");
    await a.client.$transaction([
      a.client.account.create({ data: { id: "1", label: "a-one" } }),
      a.client.account.create({ data: { id: "2", label: "a-two" } }),
    ]);

    // ONE native batch, not a replayed sequence: the prepared statements the
    // driver receives are the exact SQL the adapter qualified.
    expect(executeBatch).toHaveBeenCalledOnce();
    const submitted = executeBatch.mock.calls[0]?.[0] ?? [];
    expect(submitted).toHaveLength(2);
    for (const query of submitted) {
      expect(query.sql).toContain('"tenant_a"."ns_accounts"');
      expect(query.sql).not.toContain('"tenant_b"');
      expect(query.sql).not.toContain('"public"');
    }

    expect(await rowsIn("tenant_a")).toEqual([
      { id: "1", label: "a-one" },
      { id: "2", label: "a-two" },
    ]);
    expect(await rowsIn("tenant_b")).toEqual([{ id: "1", label: "b-one" }]);
    expect(await rowsIn("public")).toEqual([]);
  });

  test("a batch that fails leaves both the target and the sibling schema alone", async () => {
    const a = batchTenantFor("tenant_a");
    const b = clientFor("tenant_b");
    await database.exec(
      `INSERT INTO "tenant_a"."ns_accounts" VALUES ('1', 'a-seed')`
    );
    await b.account.create({ data: { id: "2", label: "b-two" } });

    // The second statement collides with the seeded key inside the SAME batch.
    await expect(
      a.client.$transaction([
        a.client.account.create({ data: { id: "2", label: "a-two" } }),
        a.client.account.create({ data: { id: "1", label: "a-clash" } }),
      ])
    ).rejects.toThrow();

    expect(await rowsIn("tenant_a")).toEqual([{ id: "1", label: "a-seed" }]);
    expect(await rowsIn("tenant_b")).toEqual([{ id: "2", label: "b-two" }]);
    expect(await rowsIn("public")).toEqual([]);
  });
});

describe("statement transforms observe already-qualified SQL", () => {
  const capture = (statements: Sql[]) =>
    defineExtension<typeof isolationSchema>()({
      name: "namespace-observer",
      statement(context) {
        statements.push(context.statement);
        return context.statement;
      },
    });

  test("the transform sees the qualified statement exactly once", async () => {
    const statements: Sql[] = [];
    const derived = clientFor("tenant_a").$extends(capture(statements));

    await derived.account.create({ data: { id: "1", label: "a-one" } });
    await derived.account.findMany();

    expect(statements).toHaveLength(2);
    for (const statement of statements) {
      const text = statement.toStatement("$n");
      expect(text).toContain('"tenant_a"."ns_accounts"');
      expect(text.split('"tenant_a"."ns_accounts"')).toHaveLength(2);
      expect(text).not.toContain('"tenant_a"."tenant_a"');
    }
    expect(await rowsIn("tenant_a")).toEqual([{ id: "1", label: "a-one" }]);
  });
});
