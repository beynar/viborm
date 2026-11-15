/**
 * `groupBy` by a time step, as statements, with no database.
 *
 * PostgreSQL: the period is computed ONCE, in a window that exposes it as a
 * column, so its zone is bound once and the grouping, the projection and the
 * order all read that one column. Written twice with two bound zones,
 * PostgreSQL refuses the projection ("must appear in the GROUP BY clause").
 *
 * Every other engine refuses the call with a typed error while it is planned:
 * no statement leaves, not even the ones queued before it in a batch.
 */

import { MySQLAdapter } from "@adapters/databases/mysql/mysql-adapter";
import { PostgresAdapter } from "@adapters/databases/postgres/postgres-adapter";
import { SQLiteAdapter } from "@adapters/databases/sqlite/sqlite-adapter";
import { createClient } from "@client/client";
import type { Dialect } from "@drivers";
import { createClient as createSnowflakeClient } from "@drivers/snowflake";
import { SurrealDriver } from "@drivers/surrealdb";
import { FeatureNotSupportedError } from "@errors";
import { hydrateSchemaNames, s, TYPES } from "@schema";
import { SqlOnlyDriver } from "@tests/fixtures/drivers/sql-only";
import {
  createModelRegistry,
  TestQueryEngine,
} from "@tests/fixtures/query-engine";
import { createSchemaRegistry } from "@validation";
import { describe, expect, test } from "vitest";

const facture = s
  .model({
    id: s.int().id(),
    statut: s.string(),
    montant: s.int(),
    date: s.dateTime(),
    wall: s.dateTime().withoutTimezone(),
    jour: s.date(),
  })
  .map("facture");
const schema = { facture };
hydrateSchemaNames(schema);

const STEPPED = {
  by: ["statut", { date: "month" }, { jour: "week" }, { wall: "year" }],
  timeZone: "America/Montreal",
  _sum: { montant: true },
  _count: true,
  orderBy: [{ date: "desc" }, { _sum: { montant: "asc" } }],
  take: 5,
} as const;

const build = (
  adapter: PostgresAdapter | MySQLAdapter | SQLiteAdapter,
  dialect: Dialect,
  args: Record<string, unknown>
) => {
  const registry = createModelRegistry(schema, createSchemaRegistry(schema));
  const engine = new TestQueryEngine(
    new SqlOnlyDriver(adapter, dialect),
    registry
  );
  const query = engine.build(facture, "groupBy", args);
  return { statement: query.toStatement("$n"), values: query.values };
};

/** A SQL-only driver that records every statement it would send. */
class RecordingDriver extends SqlOnlyDriver {
  readonly sent: unknown[] = [];
  protected override async execute<T>(
    ...args: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sent.push(args);
    return { rows: [], rowCount: 0 };
  }
  protected override async executeRaw<T>(
    ...args: unknown[]
  ): Promise<{ rows: T[]; rowCount: number }> {
    this.sent.push(args);
    return { rows: [], rowCount: 0 };
  }
}

describe("PostgreSQL: one period column per step, its zone bound once", () => {
  test("the window computes each period; the grouped read reads its column", () => {
    const { statement, values } = build(
      new PostgresAdapter(),
      "postgresql",
      STEPPED
    );
    expect(statement).toBe(
      [
        `SELECT "q0"."statut", to_char(CAST("q0"."0viborm_period:0" AS TIMESTAMP), 'YYYY-MM-DD BC') AS "date", to_char(CAST("q0"."0viborm_period:1" AS TIMESTAMP), 'YYYY-MM-DD BC') AS "jour", to_char(CAST("q0"."0viborm_period:2" AS TIMESTAMP), 'YYYY-MM-DD BC') AS "wall",`,
        ` COUNT(*) AS "_count", json_build_object($1::text, SUM("q0"."montant")) AS "_sum"`,
        ` FROM (SELECT "q1"."id", "q1"."statut", "q1"."montant", "q1"."date", "q1"."wall", "q1"."jour",`,
        ` CAST(date_trunc('month', ("q1"."date" AT TIME ZONE $2)) AS DATE) AS "0viborm_period:0",`,
        ` CAST(date_trunc('week', CAST("q1"."jour" AS TIMESTAMP)) AS DATE) AS "0viborm_period:1",`,
        ` CAST(date_trunc('year', "q1"."wall") AS DATE) AS "0viborm_period:2"`,
        ` FROM "public"."facture" AS "q1") AS "q0"`,
        ` GROUP BY "q0"."statut", "q0"."0viborm_period:0", "q0"."0viborm_period:1", "q0"."0viborm_period:2"`,
        ` ORDER BY "q0"."0viborm_period:0" DESC, SUM("q0"."montant") ASC, "q0"."statut" ASC, "q0"."0viborm_period:1" ASC, "q0"."0viborm_period:2" ASC`,
        " LIMIT $3",
      ].join("")
    );
    expect(values).toEqual(["montant", "America/Montreal", 5]);
  });

  test("without timeZone an instant is read in UTC, never in the session's zone", () => {
    const { statement, values } = build(new PostgresAdapter(), "postgresql", {
      by: [{ date: "day" }],
      _count: true,
    });
    expect(statement).toContain(`("q1"."date" AT TIME ZONE $1)`);
    expect(values).toEqual(["UTC"]);
  });

  test("a native type decides whether the column stores an instant", () => {
    const native = s
      .model({
        id: s.int().id(),
        // Declared without a zone, stored as `timestamptz`: an instant.
        zoned: s.dateTime(TYPES.PG.DATETIME.TIMESTAMPTZ(3)).withoutTimezone(),
        // Declared with one, stored as `timestamp`: as written.
        naive: s.dateTime(TYPES.PG.DATETIME.TIMESTAMP(3)),
      })
      .map("native");
    const nativeSchema = { native };
    hydrateSchemaNames(nativeSchema);
    const registry = createModelRegistry(
      nativeSchema,
      createSchemaRegistry(nativeSchema)
    );
    const engine = new TestQueryEngine(
      new SqlOnlyDriver(new PostgresAdapter(), "postgresql"),
      registry
    );
    const statement = engine
      .build(native, "groupBy", {
        by: [{ zoned: "day" }, { naive: "day" }],
        _count: true,
      })
      .toStatement("$n");
    expect(statement).toContain(
      `CAST(date_trunc('day', ("q1"."zoned" AT TIME ZONE $1)) AS DATE)`
    );
    expect(statement).toContain(
      `CAST(date_trunc('day', "q1"."naive") AS DATE)`
    );
  });
});

describe("every other engine refuses before any statement", () => {
  const STEP = { by: [{ date: "month" as const }], _count: true as const };

  for (const [name, dialect, adapter] of [
    ["MySQL", "mysql", () => new MySQLAdapter()],
    ["SQLite (and D1)", "sqlite", () => new SQLiteAdapter()],
  ] as const) {
    test(`${name}: a typed refusal, no statement sent, even after a queued one`, async () => {
      expect(() => build(adapter(), dialect, STEP)).toThrow(
        FeatureNotSupportedError
      );
      const driver = new RecordingDriver(adapter(), dialect);
      const client = createClient({ schema, driver });
      const refusal: unknown = await client.facture
        .groupBy(STEP)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(FeatureNotSupportedError);
      expect((refusal as Error).message).toBe(
        "groupBy.timeStep is not supported. Grouping by a time step is supported on PostgreSQL only."
      );
      await expect(
        client.$transaction([
          client.facture.count(),
          client.facture.groupBy(STEP),
        ])
      ).rejects.toBeInstanceOf(FeatureNotSupportedError);
      expect(driver.sent).toEqual([]);
      // The same grouping without a step is sent: the refusal is the step's.
      await client.facture.groupBy({ by: ["date"], _count: true });
      expect(driver.sent).toHaveLength(1);
    });
  }

  test("SurrealDB: the same typed refusal, its client never asked", async () => {
    const asked: PropertyKey[] = [];
    const surreal = new Proxy(
      {},
      {
        get: (_target, key) => {
          asked.push(key);
          throw new Error(`the SurrealDB client was asked for ${String(key)}`);
        },
      }
    );
    const client = createClient({
      schema,
      driver: new SurrealDriver({ client: surreal as never }),
    });
    await expect(
      client.facture.groupBy({ by: [{ date: "month" }], _count: true })
    ).rejects.toBeInstanceOf(FeatureNotSupportedError);
    expect(asked).toEqual([]);
  });

  test("Snowflake: the same typed refusal, nothing sent", async () => {
    // An in-memory transport: every request recorded, each answered as the
    // SQL API answers a statement with no rows.
    const sent: string[] = [];
    const fetch = async (input: string) => {
      sent.push(input);
      return Response.json({
        resultSetMetaData: { numRows: 0, format: "jsonv2", rowType: [] },
        data: [],
        code: "090001",
        statementHandle: "01b0-1",
        message: "Statement executed successfully.",
      });
    };
    const client = createSnowflakeClient({
      schema,
      account: "myorg-acct",
      token: "oauth-token",
      warehouse: "WH",
      database: "DB",
      namespace: "PUBLIC",
      fetch,
    });
    await expect(
      client.facture.groupBy({ by: [{ date: "month" }], _count: true })
    ).rejects.toBeInstanceOf(FeatureNotSupportedError);
    expect(sent).toEqual([]);
    // The same grouping without a step is sent: the refusal is the step's.
    await client.facture.groupBy({ by: ["date"], _count: true });
    expect(sent.length).toBeGreaterThan(0);
  });
});
