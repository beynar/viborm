/**
 * Adoption on a real PostgreSQL server, in a schema that is not on the
 * session's `search_path`: every type a transition names must be qualified,
 * and the destination proof must see what a hand-made table carries.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { createClient } from "@client/client";
import { PgDriver } from "@drivers/pg";
import { createMigrationClient } from "@migrations/dialects/all";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { s } from "@schema";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CONNECTION_STRING = process.env.PG_TEST_CONNECTION_STRING;
const describeIfDocker = CONNECTION_STRING ? describe : describe.skip;

const NS = "viborm_adoption_estate";
const STATUS = ["queued", "done"] as const;
const users = s.model({ id: s.string().id() }).map("users");
const dependency = s
  .model({ id: s.string().id(), status: s.enum(STATUS).name("status") })
  .map("dependency");
const jobs = s
  .model({ id: s.string().id(), status: s.enum(STATUS).name("status") })
  .map("jobs");

describeIfDocker("PostgreSQL adoption (docker)", () => {
  const admin = new PgDriver({ databaseUrl: CONNECTION_STRING });
  let driver: PgDriver;

  beforeEach(async () => {
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NS}" CASCADE`);
    await admin._executeRaw(`CREATE SCHEMA "${NS}"`);
    driver = new PgDriver({ databaseUrl: CONNECTION_STRING, namespace: NS });
  });

  afterEach(async () => {
    await driver.disconnect();
    await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NS}" CASCADE`);
  });

  const migrationsOf = (
    storage: MemoryEstateStorage,
    schema: Record<string, unknown>,
    tables: readonly string[]
  ) =>
    createMigrationClient(
      createClient({ schema: schema as never, driver }) as never,
      { storage, tables }
    );

  /** An estate managing `users`, applied, beside a hand-made `dependency`. */
  const estateWithRawTable = async (raw: readonly string[]) => {
    const storage = new MemoryEstateStorage();
    const first = migrationsOf(storage, { users }, ["users"]);
    await first.generate({ name: "base" });
    await first.apply();
    for (const sql of raw) await admin._executeRaw(sql);
    return storage;
  };

  it("creates a new table on the enum an adopted table brings, qualified", async () => {
    const storage = await estateWithRawTable([
      `CREATE TYPE "${NS}"."status" AS ENUM ('queued', 'done')`,
      `CREATE TABLE "${NS}"."dependency" ("id" TEXT NOT NULL, "status" "${NS}"."status" NOT NULL, CONSTRAINT "dependency_pkey" PRIMARY KEY ("id"))`,
      `INSERT INTO "${NS}"."dependency" VALUES ('kept', 'done')`,
    ]);
    const next = migrationsOf(storage, { users, dependency, jobs }, [
      "dependency",
      "jobs",
      "users",
    ]);
    const generated = await next.generate({
      name: "adopt",
      adopt: ["dependency"],
    });
    expect(generated.sql).toContain(`"status" "${NS}"."status" NOT NULL`);
    // The schema is not on the session's path: an unqualified type is 42704.
    expect((await next.apply()).outcome).toBe("applied");
    expect(await next.verify()).toEqual({ ok: true });
    const column = await admin._executeRaw<{ nspname: string }>(
      `SELECT n.nspname FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid JOIN pg_namespace n ON n.oid = t.typnamespace WHERE a.attrelid = '"${NS}"."jobs"'::regclass AND a.attname = 'status'`
    );
    expect(column.rows).toEqual([{ nspname: NS }]);

    // The rollback drops what the transition created, never the enum.
    await next.down();
    expect(await next.verify()).toEqual({ ok: true });
    const kept = await admin._executeRaw<{ typname: string }>(
      `SELECT t.typname FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = '${NS}' AND t.typtype = 'e'`
    );
    expect(kept.rows).toEqual([{ typname: "status" }]);
    expect((await next.apply()).outcome).toBe("applied");
    expect(
      (await admin._executeRaw(`SELECT * FROM "${NS}"."dependency"`)).rows
    ).toEqual([{ id: "kept", status: "done" }]);
  }, 60_000);
});
