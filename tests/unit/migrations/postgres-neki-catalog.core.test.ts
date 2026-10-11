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
 */

import { ConnectionError, QueryError, VibORMErrorCode } from "@errors";
import {
  DEFAULT_CONTROL_BASE,
  readPostgresDecision,
} from "@migrations/control";
import { getMigrationDriver } from "@migrations/drivers";
import { postgresCatalogDigestQuery } from "@migrations/drivers/postgres/catalog-digest";
import {
  introspectPostgresSchema,
  NULLS_NOT_DISTINCT_QUERY,
} from "@migrations/drivers/postgres/introspect";
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
    await readPostgresDecision(producer, driver, DEFAULT_CONTROL_BASE, "TRUE");
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
      readPostgresDecision(
        producer,
        getMigrationDriver(producer),
        DEFAULT_CONTROL_BASE,
        "TRUE"
      )
    ).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      message: expect.stringContaining(
        'PostgreSQL catalog query "control catalog" failed with SQLSTATE 0A000'
      ),
    });
  });
});
