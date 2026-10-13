/**
 * Standard PostgreSQL applies a pending history that mixes schema and data
 * states exactly as it did before PlanetScale's Neki got commit boundaries
 * (1.2.2): the whole contiguous path is one transaction, its dispatches are
 * sent once each in path order, the ledger gains one `applied` event per
 * state and never an attempt of its own, and a failure rolls the whole path
 * back, recorded as one `failed` event. Only the Neki question is asked, once,
 * because the history would need a commit there
 * (`postgres-neki-apply.test.ts` runs the same history on PGlite made to
 * refuse what Neki refuses).
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/<db>
 */

import { createClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient, MemoryEstateStorage } from "@migrations";
import {
  generateReportStates,
  REPORT_ROWS,
  reportSchema,
  reportSql,
  seedReportRows,
} from "@tests/fixtures/neki-report-states";
import { commitsIn, recordingPgPool } from "@tests/fixtures/recording-pg-pool";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;

const NAMESPACES = ["viborm_neki_boundaries", "viborm_neki_boundaries_failed"];
const NEKI_QUESTION = "SELECT pg_catalog.version() LIKE '%(Neki)%' AS neki";

describeIfPg("a mixed schema and data history on standard PostgreSQL", () => {
  const admin = new pg.Client({ connectionString: PG_CONNECTION });
  const recording = recordingPgPool({ connectionString: PG_CONNECTION });
  const clients: { $disconnect(): Promise<void> }[] = [];

  beforeAll(async () => {
    await admin.connect();
    for (const namespace of NAMESPACES) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await admin.query(`CREATE SCHEMA "${namespace}"`);
    }
  });

  afterAll(async () => {
    await Promise.allSettled(clients.map((client) => client.$disconnect()));
    await recording.pool.end().catch(() => undefined);
    for (const namespace of NAMESPACES) {
      await admin.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    }
    await admin.end();
  });

  /** The history generated past an applied, seeded first state. */
  async function pending(namespace: string) {
    const storage = new MemoryEstateStorage();
    const at = (stage: number) => {
      const client = createClient({
        pool: recording.pool,
        namespace,
        schema: reportSchema(stage),
      });
      clients.push(client);
      return createMigrationClient(client, { storage });
    };
    const v0 = await at(0).generate({ name: "people" });
    await at(0).apply();
    await admin.query(seedReportRows(namespace));
    const path = await generateReportStates(at, namespace, v0.stateId!);
    return { at, v0: v0.stateId!, path };
  }

  const forwardKinds = async (
    migrations: ReturnType<Awaited<ReturnType<typeof pending>>["at"]>,
    path: readonly string[]
  ) =>
    (await migrations.log())
      .filter(
        (event) =>
          event.direction === "forward" && path.includes(event.toState ?? "")
      )
      .map((event) => event.kind);

  it("runs the whole path in one transaction, each dispatch once, with one applied event per state", async () => {
    const { at, path } = await pending(NAMESPACES[0]!);

    recording.log.length = 0;
    const result = await at(3).apply();
    const sent = [...recording.log];
    expect(result).toMatchObject({ outcome: "applied", path });
    expect(sent.filter((text) => text === "BEGIN")).toHaveLength(1);
    expect(commitsIn(sent)).toBe(1);
    expect(sent.filter((text) => result.statements.includes(text))).toEqual(
      result.statements
    );
    expect(result.statements).toEqual(
      expect.arrayContaining([
        ...reportSql(NAMESPACES[0]!).names,
        ...reportSql(NAMESPACES[0]!).dangling,
        ...reportSql(NAMESPACES[0]!).agrees,
      ])
    );
    expect(sent.filter((text) => text === NEKI_QUESTION)).toHaveLength(1);
    expect(await forwardKinds(at(3), path)).toEqual(path.map(() => "applied"));

    const status = await at(3).status();
    expect(status.marker?.stateId).toBe(path.at(-1));
    expect(status.unfinished).toBe(false);
    await expect(at(3).verify()).resolves.toEqual({ ok: true });
    const { rows } = await admin.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM "${NAMESPACES[0]}"."people" WHERE "firstName" || ' ' || "lastName" = "name"`
    );
    expect(rows[0]?.n).toBe(REPORT_ROWS);
  });

  it("rolls the whole path back on a failure inside it, recorded as one failed event, and opens no attempt", async () => {
    const namespace = NAMESPACES[1]!;
    const { at, v0, path } = await pending(namespace);

    recording.fail = reportSql(namespace).dangling[0];
    await expect(at(3).apply()).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
    });
    const status = await at(3).status();
    expect(status.marker?.stateId).toBe(v0);
    expect(status.unfinished).toBe(false);
    expect(status.pending).toEqual(path);
    expect(await forwardKinds(at(3), path)).toEqual(["failed"]);
    const { rows } = await admin.query<{ name: string }>(
      "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'people'",
      [namespace]
    );
    expect(rows.map((row) => row.name)).not.toContain("firstName");

    await expect(at(3).apply()).resolves.toMatchObject({
      outcome: "applied",
      path,
    });
    expect(await forwardKinds(at(3), path)).toEqual([
      "failed",
      ...path.map(() => "applied"),
    ]);
  });
});
