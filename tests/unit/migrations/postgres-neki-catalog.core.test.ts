/**
 * PlanetScale's Neki speaks PostgreSQL 18 but refuses two shapes standard
 * PostgreSQL accepts: a whole-row reference to a relation (`to_jsonb(ix)`
 * over `pg_index` failed every migration command, 0A000) and a recursive CTE
 * of more than two top-level terms. Every catalog statement the PostgreSQL
 * migration driver sends is held to both here, without a provider:
 * introspection on servers with and without `pg_index.indnullsnotdistinct`
 * (PostgreSQL 15+), the catalog digest, the control catalog, the no-op
 * decision read and the migration lock. A refused catalog read names itself
 * and its SQLSTATE instead of blaming the estate.
 *
 * `postgres-neki-catalog.test.ts` runs the same reads on PGlite.
 *
 * Neki also plans a row statement against the schema committed before its
 * transaction, and cannot retype, rename or drop a column of a relation the
 * same transaction created (`.probes/hosted/neki-boundaries-1.2.2.md`):
 * `catalogCommitBoundaries` names where a commit must come, `apply` commits
 * there, and every other command is refused such a program before effects,
 * there and only there (`postgres-neki-apply.test.ts` runs the commands).
 */

import { ConnectionError, QueryError, VibORMErrorCode } from "@errors";
import { readPostgresDecision } from "@migrations/control";
import { getMigrationDriver } from "@migrations/drivers";
import { postgresCatalogDigestQuery } from "@migrations/drivers/postgres/catalog-digest";
import {
  introspectPostgresSchema,
  NULLS_NOT_DISTINCT_QUERY,
} from "@migrations/drivers/postgres/introspect";
import {
  catalogCommitBoundaries,
  UNCHANGED_CATALOG,
} from "@migrations/statement-safety";
import {
  nekiRefusals,
  recursiveTermCounts,
  wholeRowReferences,
} from "@tests/fixtures/sql-shape";
import { describe, expect, it } from "vitest";
import { pgEstateDriver, postgresControlCatalogAnswer } from "./_estate";

const SCOPE = {
  namespace: "public",
  admittedExtensionTypes: new Set<string>(),
};
const INDEXES = /FROM pg_index ix/;

/** Every statement one introspection sends, against a server that has (or lacks) the column. */
async function introspectionStatements(present: boolean): Promise<string[]> {
  const statements: string[] = [];
  await introspectPostgresSchema(async <T>(sql: string) => {
    statements.push(sql);
    return {
      rows: (sql === NULLS_NOT_DISTINCT_QUERY ? [{ present }] : []) as T[],
    };
  }, SCOPE);
  return statements;
}

describe("PostgreSQL catalog SQL holds no shape Neki refuses", () => {
  it("the shape gate sees the forms Neki refuses", () => {
    expect(
      wholeRowReferences(
        "SELECT COALESCE((to_jsonb(ix)->>'indnullsnotdistinct')::boolean,false) FROM pg_index ix"
      )
    ).toEqual(["to_jsonb(ix)"]);
    expect(
      wholeRowReferences(
        "SELECT (SELECT json_agg(row_to_json(marker)) FROM (SELECT payload FROM s) marker), (q).*, json_agg(t.*) FROM t, (SELECT 1) q"
      )
    ).toEqual(["row_to_json(marker)", "(q).*", "json_agg(t.*)"]);
    expect(
      recursiveTermCounts(
        `SELECT EXISTS (WITH RECURSIVE "r" AS (SELECT 1 AS c UNION SELECT 2 UNION SELECT c + 1 FROM "r" WHERE c < 3) SELECT 1 FROM "r")`
      )
    ).toEqual([3]);
    expect(
      recursiveTermCounts(
        `WITH RECURSIVE r AS (SELECT s.c FROM (SELECT 1 AS c UNION SELECT 2) AS s UNION ALL SELECT ' UNION ' || c FROM r) SELECT 1`
      )
    ).toEqual([2]);
  });

  it("introspection names indnullsnotdistinct only where the server has it", async () => {
    for (const present of [true, false]) {
      const statements = await introspectionStatements(present);
      expect(nekiRefusals(statements)).toEqual([]);
      const indexes = statements.filter((sql) => INDEXES.test(sql));
      expect(indexes).toHaveLength(1);
      expect(indexes[0]!.includes("ix.indnullsnotdistinct")).toBe(present);
      // Before PostgreSQL 15 the column is absent: nothing may name it.
      if (!present)
        expect(
          statements.filter((sql) => sql !== NULLS_NOT_DISTINCT_QUERY).join()
        ).not.toContain("indnullsnotdistinct");
    }
  });

  it("the digest, control catalog, decision read and lock hold the same shapes", async () => {
    const producer = pgEstateDriver("public");
    producer.respond = (sql) =>
      postgresControlCatalogAnswer(sql, {
        state: true,
        log: true,
        check: "CHECK ((singleton = 1))",
      }) ?? [];
    const driver = getMigrationDriver(producer);
    await readPostgresDecision(producer, driver, "TRUE");
    const statements = [
      ...producer.statements.filter((sql) => sql !== "<connect>"),
      postgresCatalogDigestQuery(
        driver,
        { state: "_viborm_migration_state", log: "_viborm_migration_log" },
        false
      ).sql,
      driver.generateAcquireLock(1)!,
    ];
    expect(statements.some((sql) => sql.includes("AS digest WHERE TRUE"))).toBe(
      true
    );
    expect(nekiRefusals(statements)).toEqual([]);
    expect(recursiveTermCounts(statements.at(-1)!)).toEqual([2]);
  });
});

describe("a catalog read the provider refuses names itself", () => {
  it.each([
    null,
    "not JSON",
    "{}",
    "[1]",
  ])("refuses malformed control constraints %j before reading a decision", async (constraints) => {
    const producer = pgEstateDriver("public");
    producer.respond = (sql) => {
      const rows = postgresControlCatalogAnswer(sql, {
        state: true,
        log: true,
        check: "CHECK ((singleton = 1))",
      });
      if (!rows) throw new Error("No decision may follow a refused catalog");
      const first = rows[0];
      if (typeof first !== "object" || first === null)
        throw new Error("Expected the control catalog fixture");
      Reflect.set(first, "constraints", constraints);
      return rows;
    };
    await expect(
      readPostgresDecision(producer, getMigrationDriver(producer), "TRUE")
    ).rejects.toMatchObject({ code: VibORMErrorCode.MIGRATION_INVALID_STATE });
    expect(
      producer.statements.some((sql) => sql.includes("AS digest WHERE"))
    ).toBe(false);
  });

  it("refuses a truncated control catalog rather than treating it as no history", async () => {
    const producer = pgEstateDriver("public");
    producer.respond = () => [];
    await expect(
      readPostgresDecision(producer, getMigrationDriver(producer), "TRUE")
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_INVALID_STATE,
      message: expect.stringContaining("one row per control table"),
    });
  });

  it("ignores non-record aggregate carriers without inventing marker or ledger rows", async () => {
    const producer = pgEstateDriver("public");
    producer.respond = (sql) =>
      postgresControlCatalogAnswer(sql, {
        state: true,
        log: true,
        check: "CHECK ((singleton = 1))",
      }) ?? [{ marker: "[null,1]", ledger: "[false]", digest: null }];
    await expect(
      readPostgresDecision(producer, getMigrationDriver(producer), "TRUE")
    ).resolves.toMatchObject({ marker: null, ledger: [], digest: undefined });
  });

  const refusing = (failure: Error) => async (sql: string) => {
    if (INDEXES.test(sql)) throw failure;
    return { rows: [] };
  };

  it("names the query and its SQLSTATE, keeping the provider failure as cause", async () => {
    const refusal = new QueryError("Query execution failed", {
      meta: { providerCode: "0A000", providerSqlState: "0A000" },
    });
    await expect(
      introspectPostgresSchema(refusing(refusal), SCOPE)
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message:
        'PostgreSQL catalog query "indexes" failed with SQLSTATE 0A000: Query execution failed',
      meta: { providerSqlState: "0A000" },
      originalCause: expect.any(Error),
    });
  });

  it("a transport failure is not a refusal and passes through", async () => {
    const lost = new ConnectionError("Database connection failed");
    await expect(introspectPostgresSchema(refusing(lost), SCOPE)).rejects.toBe(
      lost
    );
  });

  it("a refused control catalog read is named, not an unauthenticated estate", async () => {
    const producer = pgEstateDriver("public");
    producer.respond = (sql) =>
      sql.includes("AS control(position, name)")
        ? Object.assign(new Error("unsupported type name: pg_class"), {
            code: "0A000",
          })
        : [];
    await expect(
      readPostgresDecision(producer, getMigrationDriver(producer), "TRUE")
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining(
        'PostgreSQL catalog query "control catalog" failed with SQLSTATE 0A000'
      ),
    });
  });
});

describe("where Neki needs a commit inside one transaction", () => {
  const ADD = 'ALTER TABLE "public"."accounts" ADD COLUMN "nickname" text';
  const BACKFILL = 'UPDATE "public"."accounts" SET "nickname" = "email"';
  const VERSION = "SELECT pg_catalog.version() LIKE '%(Neki)%' AS neki";
  const at = (program: readonly string[]) =>
    catalogCommitBoundaries(program).boundaries;

  it("is read from each statement's structure, in program order", () => {
    expect(at([ADD, 'CREATE INDEX "i" ON a (b)'])).toEqual([]);
    expect(at([BACKFILL, ADD])).toEqual([]);
    // A quoted name, a literal and a comment are not statements.
    expect(
      at([
        'ALTER TABLE a ADD COLUMN "update" text -- then UPDATE',
        "COMMENT ON TABLE a IS 'INSERT'",
      ])
    ).toEqual([]);
    expect(at([BACKFILL, ADD, "SELECT 1", BACKFILL])).toEqual([2]);
    expect(catalogCommitBoundaries([BACKFILL, ADD, "SELECT 1"]).first).toEqual({
      kind: "rows",
      change: { position: 1, words: "ALTER TABLE" },
      statement: { position: 2, words: "SELECT" },
    });
    // Each boundary counts only the changes since the one before it.
    expect(at([ADD, BACKFILL, ADD, BACKFILL, BACKFILL])).toEqual([1, 3]);
  });

  it("needs no commit after the changes Neki's planner sees", () => {
    const seen = [
      'ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT \'x, y\'',
      'ALTER TABLE ONLY "a" ALTER COLUMN "b" DROP DEFAULT, ALTER "c" SET NOT NULL, ALTER COLUMN "d" DROP NOT NULL',
      'ALTER TABLE "a" ADD CONSTRAINT "a_b" CHECK ((b > 0) AND (c IN (1, 2)))',
      'ALTER TABLE "a" ADD CONSTRAINT "a_p" FOREIGN KEY ("p") REFERENCES "public"."p" ("id") ON DELETE SET NULL NOT VALID',
      'ALTER TABLE "a" VALIDATE CONSTRAINT "a_p"',
      "COMMENT ON COLUMN a.b IS 'c'",
    ];
    for (const change of seen) {
      expect(at([change, BACKFILL]), change).toEqual([]);
    }
  });

  it("commits before a statement planned after a change its planner does not see", () => {
    const unseen = [
      ADD,
      'CREATE TABLE "public"."n" ("id" text)',
      'ALTER TABLE "a" ALTER COLUMN "d" TYPE timestamptz(3) USING date_trunc(\'milliseconds\', "d")',
      'ALTER TABLE "a" RENAME COLUMN "b" TO "c"',
      'ALTER TABLE "a" RENAME TO "b"',
      'ALTER TABLE "a" DROP COLUMN "b"',
      'ALTER TABLE "a" DROP "b"',
      'ALTER TABLE "a" ADD CONSTRAINT "a_u" UNIQUE ("b")',
      'CREATE UNIQUE INDEX "a_u" ON "a" ("b")',
      // A created or dropped relation: `to_regclass('…')` answers for the
      // committed schema (measured stale on Neki).
      'CREATE INDEX "a_b" ON "a" ("b") WHERE "c" IS NULL',
      'DROP INDEX "public"."a_b"',
      'DROP TABLE "public"."gone"',
      'ALTER TABLE "a" DROP CONSTRAINT IF EXISTS "a_pkey" CASCADE',
      "CREATE TYPE \"m\" AS ENUM ('a')",
      "ALTER TYPE m ADD VALUE 'b'",
      "CREATE SEQUENCE s",
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
      "CREATE OR REPLACE VIEW v AS SELECT 1 AS c",
      'ALTER TABLE "a" ALTER COLUMN "b" SET DEFAULT 1, ADD COLUMN "c" int',
      // A literal or a quoted name cannot end a clause.
      "ALTER TABLE \"a\" ADD CHECK (b <> '('), ADD COLUMN \"z\" int, ADD CHECK (c <> ')')",
      'ALTER TABLE "a" ADD CHECK ("(" > 0), ADD COLUMN "z" int, ADD CHECK (")" > 0)',
      // A block may change the schema itself.
      "DO $$ BEGIN EXECUTE 'ALTER TABLE a ADD COLUMN z int'; END $$",
    ];
    const planned = [
      BACKFILL,
      "SELECT 1",
      "INSERT INTO a VALUES (1)",
      "DELETE FROM a",
      "WITH s AS (SELECT 1) SELECT * FROM s",
      "DO $$ BEGIN PERFORM 1; END $$",
      "CALL p()",
      'CREATE TABLE "c" AS SELECT * FROM "a"',
      "VACUUM a",
    ];
    for (const change of unseen) {
      for (const statement of planned) {
        expect(at([change, statement]), `${change} / ${statement}`).toEqual([
          1,
        ]);
      }
    }
    // Measured to run on Neki after any change: no commit.
    for (const statement of [
      "GRANT SELECT ON a TO PUBLIC",
      "SET LOCAL lock_timeout = '5s'",
      "TRUNCATE a",
      'CREATE VIEW "v" AS SELECT "z" FROM "a"',
      'CREATE INDEX "i" ON "a" ("nickname")',
    ]) {
      expect(at([ADD, statement]), statement).toEqual([]);
    }
  });

  it("commits before a column change of a relation the transaction created or renamed (NK316)", () => {
    const created =
      'CREATE TABLE IF NOT EXISTS "public"."N" ("v" int, "s" text)';
    for (const alteration of [
      'ALTER TABLE "public"."N" ALTER COLUMN "v" TYPE bigint',
      'ALTER TABLE "N" ALTER "v" SET DATA TYPE bigint',
      'ALTER TABLE "N" RENAME COLUMN "v" TO "w"',
      'ALTER TABLE "N" RENAME "v" TO "w"',
      'ALTER TABLE "N" DROP COLUMN IF EXISTS "v"',
      'ALTER TABLE "N" ADD COLUMN "w" int, DROP "v"',
      'ALTER TABLE "N" SET SCHEMA "other"',
    ]) {
      expect(catalogCommitBoundaries([created, alteration]).first).toEqual({
        kind: "columns",
        change: { position: 0, words: "CREATE TABLE" },
        statement: { position: 1, words: "ALTER TABLE" },
      });
    }
    for (const alteration of [
      'ALTER TABLE "N" ADD COLUMN "w" int',
      'ALTER TABLE "N" ALTER COLUMN "v" SET NOT NULL',
      'ALTER TABLE "N" RENAME TO "M"',
      'ALTER TABLE "N" DROP CONSTRAINT "N_pkey"',
      'ALTER TABLE "n" ALTER COLUMN "v" TYPE bigint',
      'ALTER TABLE n ALTER COLUMN "v" TYPE bigint',
    ]) {
      expect(at([created, alteration]), alteration).toEqual([]);
    }
    // A bare name folds; a renamed relation is as new as a created one.
    expect(
      at(["CREATE TABLE n (v int)", 'ALTER TABLE "n" DROP COLUMN "v"'])
    ).toEqual([1]);
    expect(
      at([
        'ALTER TABLE "a" RENAME TO "b"',
        'ALTER TABLE "b" ALTER COLUMN "c" TYPE text',
      ])
    ).toEqual([1]);
    // A commit registers it.
    expect(
      catalogCommitBoundaries(['ALTER TABLE "N" DROP COLUMN "v"'], {
        ...UNCHANGED_CATALOG,
      }).boundaries
    ).toEqual([]);
  });

  it("finds a dependent pair no commit can divide", () => {
    const one = catalogCommitBoundaries(["SELECT 1", `${ADD}; ${BACKFILL}`]);
    expect(one.boundaries).toEqual([1]);
    expect(one.inside).toEqual({
      kind: "rows",
      change: { position: 1, words: "ALTER TABLE" },
      statement: { position: 1, words: "UPDATE" },
    });
    // A function body is not its statement's: its `;` ends nothing.
    const atomic = catalogCommitBoundaries([
      "CREATE FUNCTION f() RETURNS int LANGUAGE sql BEGIN ATOMIC SELECT CASE WHEN true THEN 1 END; UPDATE a SET b = 1; END",
    ]);
    expect(atomic.boundaries).toEqual([]);
    expect(atomic.inside).toBeUndefined();
    // Divided by a commit before it, a dispatch is not one.
    const before = catalogCommitBoundaries([ADD, `${BACKFILL}; ${BACKFILL}`]);
    expect(before.boundaries).toEqual([1]);
    expect(before.inside).toBeUndefined();
  });

  const preflight = (
    program: readonly string[],
    neki: boolean,
    splits = false
  ) => {
    const asked: string[] = [];
    const run = getMigrationDriver(
      pgEstateDriver("public")
    ).preflightSchemaRequirements(
      [],
      <T>(sql: string) => {
        asked.push(sql);
        return Promise.resolve({
          rows: (sql === VERSION ? [{ neki }] : []) as T[],
        });
      },
      program,
      splits
    );
    return { asked, run };
  };

  it("is refused before effects on Neki, naming both statements", async () => {
    const { asked, run } = preflight([ADD, BACKFILL], true);
    await expect(run).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining(
        "runs statement 2 (UPDATE) after statement 1 (ALTER TABLE)"
      ),
      meta: {
        dialect: "postgresql",
        feature: "data after schema change in one transaction",
      },
    });
    expect(asked).toEqual([VERSION]);
    await expect(
      preflight(
        ['CREATE TABLE "n" ("v" int)', 'ALTER TABLE "n" DROP COLUMN "v"'],
        true
      ).run
    ).rejects.toMatchObject({
      message: expect.stringContaining("(NK316)"),
      meta: { feature: "column change of a new relation in one transaction" },
    });
  });

  it("answers a command that commits at the boundaries, refusing only what none divides", async () => {
    const split = preflight([ADD, BACKFILL], true, true);
    await expect(split.run).resolves.toBe(true);
    expect(split.asked).toEqual([VERSION]);

    await expect(
      preflight([`${ADD}; ${BACKFILL}`], true, true).run
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
      message: expect.stringContaining(
        "statement 1 of this migration runs UPDATE after ALTER TABLE in one dispatch"
      ),
      meta: { feature: "dependent statements in one dispatch" },
    });
  });

  it("runs on PostgreSQL, which asks once, and is never asked of a program without one", async () => {
    const postgres = preflight([ADD, BACKFILL], false);
    await expect(postgres.run).resolves.toBe(false);
    expect(postgres.asked).toEqual([VERSION]);
    const splitting = preflight([`${ADD}; ${BACKFILL}`], false, true);
    await expect(splitting.run).resolves.toBe(false);

    const schemaOnly = preflight([ADD], true);
    await expect(schemaOnly.run).resolves.toBe(false);
    expect(schemaOnly.asked).toEqual([]);
  });
});
