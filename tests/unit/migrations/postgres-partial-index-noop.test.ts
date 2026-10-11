/**
 * A soft-delete estate's no-op `apply` on PostgreSQL (plan D5 follow-up,
 * owner decision 2026-10-11). PostgreSQL keeps an index predicate parsed and
 * deparses it its own way (`"deletedAt" IS NULL` reads back as
 * `("deletedAt" IS NULL)`), which only a scratch view canonicalizes, so the
 * one-statement catalog digest abstained on every partial index and the
 * no-op of every soft-delete estate took the locked proof, about 30
 * statements. The apply that reaches a state now records beside the marker
 * each partial index's predicate as the server deparsed it, read from the
 * catalog once the state is proven, and the no-op compares the live deparse
 * with it in its one statement.
 *
 * The estate is realistic: 10,000 rows, a tenth of them tombstoned.
 * `postgres-catalog-digest-docker.test.ts` proves the same on a server.
 */

import { createClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import { controlTableNames, DEFAULT_CONTROL_BASE } from "@migrations/control";
import { postgresCatalogDigestQuery } from "@migrations/drivers/postgres/catalog-digest";
import { getPushMigrationDriver } from "@migrations/push/planner";
import { fingerprintSnapshot } from "@migrations/push-fingerprint";
import { introspectManaged } from "@migrations/push-plan";
import { s } from "@schema";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { beforeAll, describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const ROWS = 10_000;
const NOOP_MAX = 3;
const NAMESPACE = "soft_delete";
const STATE = `"${NAMESPACE}"."_viborm_migration_state"`;

const decoder = new TextDecoder();

/** Every statement `command` makes PGlite run, in order. */
async function statementsOf<T>(
  database: PGlite,
  command: () => Promise<T>
): Promise<{ readonly result: T; readonly statements: string[] }> {
  const send = database.execProtocolStream;
  const statements: string[] = [];
  database.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      statements.push(
        decoder.decode(message.subarray(start, message.indexOf(0, start)))
      );
    }
    return send.call(database, message, options);
  };
  try {
    return { result: await command(), statements };
  } finally {
    database.execProtocolStream = send;
  }
}

/** The marker row's payload, as stored. */
async function markerRow(database: PGlite): Promise<Record<string, unknown>> {
  const { rows } = await database.query<{ payload: string }>(
    `SELECT payload FROM ${STATE} WHERE singleton = 1`
  );
  return JSON.parse(rows[0]!.payload);
}

describe("a soft-delete estate of 10,000 rows on PGlite", () => {
  const database = openTestPGlite();
  const storage = new MemoryEstateStorage();
  const orm = (nickname = false) =>
    createClient({
      client: database,
      schema: softDeleteAccounts(nickname),
      namespace: NAMESPACE,
    });
  const migrations = () => createMigrationClient(orm(true), { storage });

  beforeAll(async () => {
    await database.exec(`CREATE SCHEMA "${NAMESPACE}"`);
    const first = createMigrationClient(orm(), { storage });
    await first.generate({ name: "v1" });
    await first.apply();
    await database.exec(
      `INSERT INTO "${NAMESPACE}"."accounts" ("id", "email", "deletedAt")
       SELECT 'acct-' || g, 'user' || (g % 9000) || '@example.com',
         CASE WHEN g > 9000 THEN now() END
       FROM generate_series(1, ${ROWS}) g;
       UPDATE "${NAMESPACE}"."accounts" SET "status" = 'churned' WHERE "id" LIKE '%3';`
    );
    await migrations().generate({ name: "nickname" });
    await migrations().apply();
  });

  it("records each partial index's predicate as PostgreSQL deparsed it", async () => {
    const { rows } = await database.query<{
      index: string;
      deparsed: string;
    }>(
      `SELECT i.relname AS index, pg_get_expr(x.indpred, x.indrelid) AS deparsed
       FROM pg_index x JOIN pg_class i ON i.oid = x.indexrelid
       JOIN pg_namespace n ON n.oid = i.relnamespace
       WHERE n.nspname = $1 AND x.indpred IS NOT NULL ORDER BY 1`,
      [NAMESPACE]
    );
    // Not the declared `"deletedAt" IS NULL`.
    expect(rows[1]?.deparsed).toBe(`("deletedAt" IS NULL)`);
    expect((await markerRow(database)).predicates).toEqual(
      rows.map(({ index, deparsed }) => ({
        table: "accounts",
        index,
        deparsed,
      }))
    );
  });

  it(`a no-op apply sends at most ${NOOP_MAX} statements`, async () => {
    const { result, statements } = await statementsOf(database, () =>
      migrations().apply()
    );

    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeLessThanOrEqual(NOOP_MAX);
  });

  it("with deparsed predicates the digest is fingerprintSnapshot of an introspection", async () => {
    const client = orm(true);
    const driver = getPushMigrationDriver(client);
    const digest = (deparsed: boolean) => {
      const query = postgresCatalogDigestQuery(
        driver,
        controlTableNames(DEFAULT_CONTROL_BASE),
        deparsed
      );
      return client.$driver
        ._executeRaw<{ digest: string | null }>(query.sql, query.parameters)
        .then(({ rows }) => rows[0]?.digest);
    };

    expect(await digest(true)).toBe(
      fingerprintSnapshot(
        await introspectManaged(client.$driver, driver),
        driver
      )
    );
    // Without them it still abstains: a deparse is not `fingerprintLive`'s
    // canonical predicate.
    expect(await digest(false)).toBeNull();
  });

  it("a live predicate that differs from the recorded one is drift, even in the same index", async () => {
    const recreate = (predicate: string) =>
      database.exec(
        `DROP INDEX "${NAMESPACE}"."accounts_live_email";
         CREATE UNIQUE INDEX "accounts_live_email" ON "${NAMESPACE}"."accounts" ("email") WHERE ${predicate}`
      );
    await recreate(`"deletedAt" IS NOT NULL`);
    try {
      await expect(migrations().apply()).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_DRIFT,
      });
    } finally {
      // Spelled otherwise, the same predicate deparses the same.
      await recreate(`(("deletedAt") IS NULL)`);
    }
    const { result, statements } = await statementsOf(database, () =>
      migrations().apply()
    );
    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeLessThanOrEqual(NOOP_MAX);
  });

  it("a record the server no longer deparses alike takes the locked proof, never a defect", async () => {
    const stored = await markerRow(database);
    const stale = (stored.predicates as { deparsed: string }[]).map(
      (record) => ({ ...record, deparsed: record.deparsed.toLowerCase() })
    );
    await database.query(`UPDATE ${STATE} SET payload = $1`, [
      JSON.stringify({ ...stored, predicates: stale }),
    ]);
    try {
      const { result, statements } = await statementsOf(database, () =>
        migrations().apply()
      );
      expect(result.outcome).toBe("noop");
      expect(statements.length).toBeGreaterThan(NOOP_MAX);
    } finally {
      await database.query(`UPDATE ${STATE} SET payload = $1`, [
        JSON.stringify(stored),
      ]);
    }
  });

  it("a malformed record is refused as a corrupt marker, by apply and status", async () => {
    const stored = await markerRow(database);
    const [record] = stored.predicates as Record<string, unknown>[];
    try {
      for (const predicates of [
        "accounts_live_email",
        [{ ...record, extra: true }],
        [{ ...record, deparsed: 1 }],
      ]) {
        await database.query(`UPDATE ${STATE} SET payload = $1`, [
          JSON.stringify({ ...stored, predicates }),
        ]);
        await expect(migrations().apply()).rejects.toMatchObject({
          code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        });
        await expect(migrations().status()).rejects.toMatchObject({
          code: VibORMErrorCode.MIGRATION_INVALID_ESTATE,
        });
      }
    } finally {
      await database.query(`UPDATE ${STATE} SET payload = $1`, [
        JSON.stringify(stored),
      ]);
    }
  });

  it("predicates of every common form, quotes and backslashes included, compare as deparsed", async () => {
    await database.exec(`CREATE SCHEMA "predicate_forms"`);
    const forms = createMigrationClient(
      createClient({
        client: database,
        namespace: "predicate_forms",
        schema: {
          person: s
            .model({
              id: s.string().id(),
              email: s.string(),
              age: s.int().nullable(),
              verified: s.boolean().default(false),
              country: s.string().default("FR"),
            })
            .index(["email"], { name: "p_verified", where: `"verified"` })
            .index(["age"], {
              name: "p_adult",
              where: `"age" >= 18 AND "country" IN ('FR', 'DE')`,
            })
            .index(["email"], {
              name: "p_quoted",
              unique: true,
              where: `lower("email") <> 'o''hara' AND "email" NOT LIKE E'%\\\\%'`,
            })
            .map("people"),
        },
      }),
      { storage: new MemoryEstateStorage() }
    );
    await forms.generate({ name: "forms" });
    await forms.apply();

    const { result, statements } = await statementsOf(database, () =>
      forms.apply()
    );
    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeLessThanOrEqual(NOOP_MAX);
  });

  it("a BETWEEN inside an AND is the same predicate live as declared: the first apply proves it", async () => {
    // PostgreSQL expands BETWEEN after the grammar has flattened AND, so the
    // declared text parses to a nested AND that its own deparse reparses flat.
    await database.exec(`CREATE SCHEMA "predicate_band"`);
    const band = createMigrationClient(
      createClient({
        client: database,
        namespace: "predicate_band",
        schema: {
          person: s
            .model({
              id: s.string().id(),
              age: s.int(),
              country: s.string(),
            })
            .index(["age"], {
              name: "p_band",
              where: `"age" BETWEEN 18 AND 65 AND "country" IN ('FR', 'DE')`,
            }),
        },
      }),
      { storage: new MemoryEstateStorage() }
    );
    await band.generate({ name: "band" });

    expect((await band.apply()).outcome).toBe("applied");
    const { result, statements } = await statementsOf(database, () =>
      band.apply()
    );
    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeLessThanOrEqual(NOOP_MAX);
  });

  it("a marker without the record, as 1.1.0 wrote it, still answers noop through the locked proof", async () => {
    const { predicates: _, ...marker } = await markerRow(database);
    await database.query(`UPDATE ${STATE} SET payload = $1`, [
      JSON.stringify(marker),
    ]);

    const { result, statements } = await statementsOf(database, () =>
      migrations().apply()
    );
    expect(result.outcome).toBe("noop");
    expect(statements.length).toBeGreaterThan(NOOP_MAX);
    expect(await migrations().status()).toMatchObject({ pending: [] });
  });
});
