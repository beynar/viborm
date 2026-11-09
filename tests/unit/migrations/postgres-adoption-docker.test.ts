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
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

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
  // Created in a hook: a skipped describe still runs its body to collect it.
  let admin: PgDriver;
  let driver: PgDriver;

  beforeAll(() => {
    admin = new PgDriver({ databaseUrl: CONNECTION_STRING });
  });
  afterAll(async () => {
    await admin.disconnect();
  });

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

  const labelled = s
    .model({ x: s.string().id(), n: s.int(), label: s.string() })
    .index(["n"])
    .map("dependency");
  const COLUMNS = `"x" TEXT NOT NULL, "n" INTEGER NOT NULL, "label" TEXT NOT NULL`;
  const KEY = `CONSTRAINT "dependency_pkey" PRIMARY KEY ("x")`;
  const table = (body = `${COLUMNS}, ${KEY}`, kind = "TABLE") =>
    `CREATE ${kind} "${NS}"."dependency" (${body})`;
  const INDEX = `CREATE INDEX "dependency_n_idx" ON "${NS}"."dependency" ("n")`;
  const SEED = `INSERT INTO "${NS}"."dependency" VALUES ('kept', 1, 'k')`;

  it("refuses before any effect a table carrying behaviour its declaration does not state", async () => {
    const hazards: [string, readonly string[]][] = [
      ["CHECK constraints", [table(`${COLUMNS}, ${KEY}, CHECK ("n" > 0)`)]],
      [
        'a collation on column "label"',
        [
          table(
            `"x" TEXT NOT NULL, "n" INTEGER NOT NULL, "label" TEXT COLLATE "C" NOT NULL, ${KEY}`
          ),
        ],
      ],
      [
        "triggers",
        [
          table(),
          `CREATE FUNCTION "${NS}".refuse() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'no'; END $$`,
          `CREATE TRIGGER no_inserts BEFORE INSERT ON "${NS}"."dependency" FOR EACH ROW EXECUTE FUNCTION "${NS}".refuse()`,
        ],
      ],
      [
        "rules",
        [
          table(),
          `CREATE RULE no_deletes AS ON DELETE TO "${NS}"."dependency" DO INSTEAD NOTHING`,
        ],
      ],
      ["UNLOGGED storage", [table(undefined, "UNLOGGED TABLE")]],
      [
        "row-level security",
        [
          table(),
          `ALTER TABLE "${NS}"."dependency" ENABLE ROW LEVEL SECURITY`,
          `ALTER TABLE "${NS}"."dependency" FORCE ROW LEVEL SECURITY`,
        ],
      ],
      [
        "DEFERRABLE keys",
        [table(`${COLUMNS}, ${KEY} DEFERRABLE INITIALLY DEFERRED`)],
      ],
    ];
    for (const [feature, ddl] of hazards) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${NS}" CASCADE`);
      await admin._executeRaw(`CREATE SCHEMA "${NS}"`);
      const [create, ...rest] = ddl;
      const storage = await estateWithRawTable([create!, INDEX, SEED, ...rest]);
      const next = migrationsOf(storage, { users, dependency: labelled }, [
        "dependency",
        "users",
      ]);
      const base = (await next.status()).marker?.stateId;
      await next.generate({ name: "adopt", adopt: ["dependency"] });
      for (const run of [
        () => next.apply(),
        () => next.reset({ dryRun: true }),
      ]) {
        await expect(run(), feature).rejects.toMatchObject({
          code: "V11014",
          message: expect.stringContaining(
            `Cannot adopt "dependency": it has ${feature}`
          ),
        });
      }
      expect((await next.status()).marker?.stateId, feature).toBe(base);
      expect(
        (await admin._executeRaw(`SELECT * FROM "${NS}"."dependency"`)).rows,
        feature
      ).toHaveLength(1);
    }
  }, 120_000);

  it("adopts the declaration's own shape, and never asks again once it is managed", async () => {
    const storage = await estateWithRawTable([table(), INDEX, SEED]);
    const next = migrationsOf(storage, { users, dependency: labelled }, [
      "dependency",
      "users",
    ]);
    await next.generate({ name: "adopt", adopt: ["dependency"] });
    expect((await next.apply()).outcome).toBe("applied");
    // Managed now: a trigger is the user's business, as on any managed table.
    await admin._executeRaw(
      `CREATE FUNCTION "${NS}".touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`
    );
    await admin._executeRaw(
      `CREATE TRIGGER touch BEFORE INSERT ON "${NS}"."dependency" FOR EACH ROW EXECUTE FUNCTION "${NS}".touch()`
    );
    expect(await next.verify()).toEqual({ ok: true });
  }, 60_000);
});
