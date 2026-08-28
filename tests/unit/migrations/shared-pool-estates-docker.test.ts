/**
 * Two estates over ONE physical connection pool — live, on both dialects.
 *
 * `namespace-execution-target.core.test.ts` already proves that two drivers
 * sharing one supplied pool COMPILE each other's namespace out of their SQL,
 * but it executes nothing. `pinned-session-docker.test.ts` and the docker
 * provider suites execute for real, but each estate there owns its own pool, so
 * "the estates are isolated" is carried in part by the pools being different
 * objects. The shape §12.26 names is the one neither covers: ONE pool object,
 * two estates, MIGRATION work — DDL, the tracking ledger, and the cross-estate
 * refusal — with nothing but the rendered qualifier keeping them apart.
 *
 * A supplied pool is opaque (§5.3): VibORM derives no target from it and never
 * changes its session state. Each dialect therefore gets a decoy that an
 * unqualified statement would land in and succeed against — `public` on
 * PostgreSQL, the pool's own default database on MySQL — so containment is a
 * claim only correctly qualified statements can satisfy. Every acquisition is
 * counted on the pool object itself, so "both estates ran through this one
 * pool" is measured rather than assumed.
 *
 * The pools are created and ended by this file, never by a driver: a supplied
 * pool belongs to the caller.
 *
 * Requires the Docker test databases:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 *   MYSQL_TEST_CONNECTION_STRING=mysql://root:password@127.0.0.1:3307/viborm
 */

import { createClient } from "@client/client";
import { MySQL2Driver } from "@drivers/mysql2";
import { PgDriver } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { apply, generate } from "@migrations";
import { s } from "@schema";
import { createPool, type Pool as MySQLPool } from "mysql2/promise";
import { Pool as PgPool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncLiveSchema } from "../../fixtures/sync-schema";
import { MemoryStorage } from "./_estate";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING ?? "";
const MYSQL_CONNECTION = process.env.MYSQL_TEST_CONNECTION_STRING ?? "";
const describeIfPg = PG_CONNECTION ? describe : describe.skip;
const describeIfMysql = MYSQL_CONNECTION ? describe : describe.skip;

const ALPHA = "viborm_sp_alpha";
const BETA = "viborm_sp_beta";
const CONTROL_STATE = "_viborm_migration_state";
const CONTROL_LOG = "_viborm_migration_log";
const DECOY_LEDGER = "_viborm_migrations";

const estateSchema = (() => {
  const note = s
    .model({
      id: s.string().id(),
      body: s.string(),
    })
    .map("sp_notes");
  return { note };
})();

const applySchema = (() => {
  const note = estateSchema.note;
  const relative = s.model({ id: s.string().id() }).map("sp_relative");
  return { note, relative };
})();

// =============================================================================
// POSTGRESQL — two schema estates, one pg.Pool object
// =============================================================================

describeIfPg("two PostgreSQL estates over one pg.Pool", () => {
  let pool: PgPool;
  /** Unbound view of the SAME pool, used only to inspect the server. */
  let admin: PgDriver;
  let acquisitions = 0;

  function estateClient(namespace: string) {
    return createClient({
      schema: estateSchema,
      driver: new PgDriver({ pool, namespace }),
    });
  }

  beforeAll(async () => {
    pool = new PgPool({ connectionString: PG_CONNECTION });
    pool.on("acquire", () => {
      acquisitions += 1;
    });
    admin = new PgDriver({ pool });
    for (const schema of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin._executeRaw(`CREATE SCHEMA "${schema}"`);
    }
    // Decoys in `public`, identically named and identically shaped: a statement
    // that lost its qualifier succeeds against these instead of failing.
    await admin._executeRaw('DROP TABLE IF EXISTS "public"."sp_notes" CASCADE');
    await admin._executeRaw(
      `DROP TABLE IF EXISTS "public"."${DECOY_LEDGER}" CASCADE`
    );
    await admin._executeRaw(
      'CREATE TABLE "public"."sp_notes" ("id" TEXT PRIMARY KEY, "decoy" TEXT)'
    );
    await admin._executeRaw(
      `CREATE TABLE "public"."${DECOY_LEDGER}" (
         id SERIAL PRIMARY KEY,
         name VARCHAR(255) NOT NULL UNIQUE,
         checksum VARCHAR(64) NOT NULL,
         applied_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
       )`
    );
  });

  afterAll(async () => {
    for (const schema of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    }
    await admin._executeRaw('DROP TABLE IF EXISTS "public"."sp_notes" CASCADE');
    await admin._executeRaw(
      `DROP TABLE IF EXISTS "public"."${DECOY_LEDGER}" CASCADE`
    );
    // The pool is the caller's, so the caller ends it — no driver does.
    await pool.end();
  });

  async function tablesIn(schema: string): Promise<string[]> {
    const result = await admin._executeRaw<{ table_name: string }>(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name",
      [schema]
    );
    return result.rows.map((row) => row.table_name);
  }

  async function decoyLedgerIn(schema: string): Promise<string[]> {
    const result = await admin._executeRaw<{ name: string }>(
      `SELECT name FROM "${schema}"."${DECOY_LEDGER}" ORDER BY name`
    );
    return result.rows.map((row) => row.name);
  }

  it("pushes two estates through one pool object and keeps both contained", async () => {
    const alpha = estateClient(ALPHA);
    const beta = estateClient(BETA);

    const beforeAlpha = acquisitions;
    expect((await syncLiveSchema(alpha)).operations.length).toBeGreaterThan(0);
    const afterAlpha = acquisitions;
    expect((await syncLiveSchema(beta)).operations.length).toBeGreaterThan(0);
    const afterBeta = acquisitions;

    // Both estates' migration work was served by THIS pool object — the shape
    // the criterion is about, measured on the pool rather than assumed.
    expect(afterAlpha).toBeGreaterThan(beforeAlpha);
    expect(afterBeta).toBeGreaterThan(afterAlpha);

    expect(await tablesIn(ALPHA)).toEqual(["sp_notes"]);
    expect(await tablesIn(BETA)).toEqual(["sp_notes"]);

    // Both converge: each introspects only its own schema even though the
    // answering connection is drawn from a pool they share.
    expect((await syncLiveSchema(alpha)).operations).toEqual([]);
    expect((await syncLiveSchema(beta)).operations).toEqual([]);

    // The decoy is untouched: nothing lost its qualifier.
    const decoy = await admin._executeRaw<{ column_name: string }>(
      "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sp_notes' ORDER BY column_name"
    );
    expect(decoy.rows.map((row) => row.column_name)).toEqual(["decoy", "id"]);
  });

  it("applies each estate's generated state into its OWN control tables", async () => {
    for (const schema of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin._executeRaw(`CREATE SCHEMA "${schema}"`);
    }
    const applyClient = (namespace: string) =>
      createClient({
        schema: applySchema,
        driver: new PgDriver({ pool, namespace }),
      });
    const alphaStorage = new MemoryStorage();
    const betaStorage = new MemoryStorage();
    const alpha = applyClient(ALPHA);
    const beta = applyClient(BETA);
    const alphaGen = await generate(alpha, alphaStorage, {
      name: "sp_alpha_entry",
    });
    const betaGen = await generate(beta, betaStorage, {
      name: "sp_beta_entry",
    });
    expect(alphaGen.outcome).toBe("published");
    expect(betaGen.outcome).toBe("published");

    const alphaResult = await apply(alpha, alphaStorage);
    const betaResult = await apply(beta, betaStorage);
    expect(alphaResult).toMatchObject({
      outcome: "applied",
    });
    expect(betaResult).toMatchObject({
      outcome: "applied",
    });
    expect(alphaResult.path).toHaveLength(1);
    expect(betaResult.path).toHaveLength(1);

    expect(await tablesIn(ALPHA)).toEqual([
      CONTROL_LOG,
      CONTROL_STATE,
      "sp_notes",
      "sp_relative",
    ]);
    expect(await tablesIn(BETA)).toEqual([
      CONTROL_LOG,
      CONTROL_STATE,
      "sp_notes",
      "sp_relative",
    ]);
    // The `public` decoy ledger — which every unqualified tracking statement
    // would have found — recorded nothing, and V1 control tables stayed out.
    expect(await decoyLedgerIn("public")).toEqual([]);
    expect(await tablesIn("public")).not.toContain(CONTROL_STATE);
    expect(await tablesIn("public")).not.toContain(CONTROL_LOG);
  });

  it("refuses a cross-estate foreign key at the exact declared boundary", async () => {
    await admin._executeRaw(
      `ALTER TABLE "${BETA}"."sp_notes" ADD COLUMN "alpha_id" TEXT REFERENCES "${ALPHA}"."sp_notes"("id")`
    );
    try {
      const failure = await syncLiveSchema(estateClient(ALPHA)).then(
        () => undefined,
        (error: unknown) => error
      );
      expect(failure).toMatchObject({
        code: VibORMErrorCode.FEATURE_NOT_SUPPORTED,
        meta: { feature: "cross-schema-foreign-key" },
      });
      // The refusal names BOTH sides of the boundary it will not cross, not
      // merely "unsupported".
      expect(String(failure)).toContain(`"${BETA}"."sp_notes"`);
      expect(String(failure)).toContain(`"${ALPHA}"."sp_notes"`);

      // Alpha's refused command changed nothing on either side.
      expect(await tablesIn(ALPHA)).toEqual([
        CONTROL_LOG,
        CONTROL_STATE,
        "sp_notes",
        "sp_relative",
      ]);
      const columns = await admin._executeRaw<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'sp_notes'",
        [BETA]
      );
      expect(columns.rows.map((row) => row.column_name)).toContain("alpha_id");
    } finally {
      await admin._executeRaw(
        `ALTER TABLE "${BETA}"."sp_notes" DROP COLUMN "alpha_id"`
      );
    }
  });
});

// =============================================================================
// MYSQL — two database estates, one mysql2 pool object
// =============================================================================

describeIfMysql("two MySQL estates over one mysql2 pool", () => {
  let pool: MySQLPool;
  let admin: MySQL2Driver;
  let acquisitions = 0;
  /** The pool's OWN default database — neither estate, so a live decoy. */
  let poolDatabase = "";
  /**
   * What that database held before this suite ran. It is the shared docker
   * database, so other suites leave tables in it; the claim here is that this
   * suite's estates add nothing to it, not that it is empty.
   */
  let poolDatabaseBaseline: string[] = [];

  function estateClient(namespace: string) {
    return createClient({
      schema: estateSchema,
      driver: new MySQL2Driver({
        pool,
        namespace,
        migrationNamespaceAttestation: "non-redirecting",
      }),
    });
  }

  beforeAll(async () => {
    pool = createPool(MYSQL_CONNECTION);
    pool.on("acquire", () => {
      acquisitions += 1;
    });
    admin = new MySQL2Driver({
      pool,
      migrationNamespaceAttestation: "non-redirecting",
    });
    const current = await admin._executeRaw<{ db: string | null }>(
      "SELECT DATABASE() AS db"
    );
    poolDatabase = current.rows[0]?.db ?? "";
    if (
      poolDatabase === "" ||
      poolDatabase === ALPHA ||
      poolDatabase === BETA
    ) {
      throw new Error(
        `the pool's own database must be a third database; got "${poolDatabase}"`
      );
    }

    for (const database of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin._executeRaw(`CREATE DATABASE \`${database}\``);
    }
    // Decoys in the pool's own database.
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`${DECOY_LEDGER}\``
    );
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`sp_relative\``
    );
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`sp_notes\``
    );
    await admin._executeRaw(
      `CREATE TABLE \`${poolDatabase}\`.\`${DECOY_LEDGER}\` (
         id INT AUTO_INCREMENT PRIMARY KEY,
         name VARCHAR(255) NOT NULL UNIQUE,
         checksum VARCHAR(64) NOT NULL,
         applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
       )`
    );
    poolDatabaseBaseline = await tablesIn(poolDatabase);
    if (!poolDatabaseBaseline.includes(DECOY_LEDGER)) {
      throw new Error("the decoy ledger was not created in the pool database");
    }
  });

  afterAll(async () => {
    for (const database of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP DATABASE IF EXISTS \`${database}\``);
    }
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`${DECOY_LEDGER}\``
    );
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`sp_relative\``
    );
    await admin._executeRaw(
      `DROP TABLE IF EXISTS \`${poolDatabase}\`.\`sp_notes\``
    );
    // The pool is the caller's, so the caller ends it.
    await pool.end();
  });

  async function tablesIn(database: string): Promise<string[]> {
    const result = await admin._executeRaw<{ TABLE_NAME: string }>(
      "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
      [database]
    );
    return result.rows.map((row) => row.TABLE_NAME);
  }

  async function decoyLedgerIn(database: string): Promise<string[]> {
    const result = await admin._executeRaw<{ name: string }>(
      `SELECT \`name\` FROM \`${database}\`.\`${DECOY_LEDGER}\` ORDER BY \`name\``
    );
    return result.rows.map((row) => row.name);
  }

  it("pushes two estates through one pool object and keeps both contained", async () => {
    const alpha = estateClient(ALPHA);
    const beta = estateClient(BETA);

    const beforeAlpha = acquisitions;
    expect((await syncLiveSchema(alpha)).operations.length).toBeGreaterThan(0);
    const afterAlpha = acquisitions;
    expect((await syncLiveSchema(beta)).operations.length).toBeGreaterThan(0);
    expect(afterAlpha).toBeGreaterThan(beforeAlpha);
    expect(acquisitions).toBeGreaterThan(afterAlpha);

    expect(await tablesIn(ALPHA)).toEqual(["sp_notes"]);
    expect(await tablesIn(BETA)).toEqual(["sp_notes"]);
    // The pool's own database is exactly as this suite found it: every DDL
    // statement named its target instead of the connection's.
    expect(await tablesIn(poolDatabase)).toEqual(poolDatabaseBaseline);

    expect((await syncLiveSchema(alpha)).operations).toEqual([]);
    expect((await syncLiveSchema(beta)).operations).toEqual([]);

    // Runtime writes through one estate are invisible to the other, over the
    // very same pool.
    await alpha.note.create({ data: { id: "a1", body: "alpha" } });
    await beta.note.create({ data: { id: "b1", body: "beta" } });
    expect(
      (await alpha.note.findMany({})).map((row: { id: string }) => row.id)
    ).toEqual(["a1"]);
    expect(
      (await beta.note.findMany({})).map((row: { id: string }) => row.id)
    ).toEqual(["b1"]);
  });

  it("applies each estate's generated state into its own database", async () => {
    for (const database of [ALPHA, BETA]) {
      await admin._executeRaw(`DROP DATABASE IF EXISTS \`${database}\``);
      await admin._executeRaw(`CREATE DATABASE \`${database}\``);
    }
    const applyClient = (namespace: string) =>
      createClient({
        schema: applySchema,
        driver: new MySQL2Driver({
          pool,
          namespace,
          migrationNamespaceAttestation: "non-redirecting",
        }),
      });
    const alphaStorage = new MemoryStorage();
    const betaStorage = new MemoryStorage();
    const alpha = applyClient(ALPHA);
    const beta = applyClient(BETA);
    // A generated MySQL artifact is database-relative: run verbatim on this
    // pool it would land in the pool's own database. Validated target
    // selection is what puts it in the configured estate — here twice, over
    // one pool, without either selection leaking into the other.
    expect(
      (await generate(alpha, alphaStorage, { name: "sp_alpha_relative" }))
        .outcome
    ).toBe("published");
    expect(
      (await generate(beta, betaStorage, { name: "sp_beta_relative" })).outcome
    ).toBe("published");

    const alphaResult = await apply(alpha, alphaStorage);
    const betaResult = await apply(beta, betaStorage);
    expect(alphaResult.outcome).toBe("applied");
    expect(betaResult.outcome).toBe("applied");
    expect(alphaResult.path).toHaveLength(1);
    expect(betaResult.path).toHaveLength(1);

    expect(await tablesIn(ALPHA)).toEqual([
      CONTROL_LOG,
      CONTROL_STATE,
      "sp_notes",
      "sp_relative",
    ]);
    expect(await tablesIn(BETA)).toEqual([
      CONTROL_LOG,
      CONTROL_STATE,
      "sp_notes",
      "sp_relative",
    ]);
    // The pool's own database is still exactly as this suite found it, and its
    // decoy ledger — which every unqualified tracking statement would have
    // found — is still empty.
    expect(await tablesIn(poolDatabase)).toEqual(poolDatabaseBaseline);
    expect(await decoyLedgerIn(poolDatabase)).toEqual([]);
    expect(await tablesIn(poolDatabase)).not.toContain(CONTROL_STATE);
    expect(await tablesIn(poolDatabase)).not.toContain(CONTROL_LOG);
  });

  it("refuses a cross-estate foreign key at the exact declared boundary", async () => {
    await admin._executeRaw(
      `ALTER TABLE \`${BETA}\`.\`sp_notes\` ADD COLUMN \`alpha_id\` VARCHAR(255) NULL, ADD CONSTRAINT \`sp_cross\` FOREIGN KEY (\`alpha_id\`) REFERENCES \`${ALPHA}\`.\`sp_notes\`(\`id\`)`
    );
    try {
      const failure = await syncLiveSchema(estateClient(ALPHA)).then(
        () => undefined,
        (error: unknown) => error
      );
      // MySQL refuses this class as MIGRATION_INVALID_STATE, where PostgreSQL
      // refuses it as FEATURE_NOT_SUPPORTED. Both refuse before any snapshot,
      // plan or DDL and both name the whole crossing; the codes are each
      // dialect's own landed spelling, asserted here as they ship.
      expect(failure).toMatchObject({
        code: VibORMErrorCode.MIGRATION_INVALID_STATE,
        meta: {
          type: "cross-database-foreign-key",
          constraint: "sp_cross",
          table: `${BETA}.sp_notes`,
          referencedTable: `${ALPHA}.sp_notes`,
          namespace: ALPHA,
        },
      });
    } finally {
      await admin._executeRaw(
        `ALTER TABLE \`${BETA}\`.\`sp_notes\` DROP FOREIGN KEY \`sp_cross\``
      );
      await admin._executeRaw(
        `ALTER TABLE \`${BETA}\`.\`sp_notes\` DROP COLUMN \`alpha_id\``
      );
    }
  });
});
