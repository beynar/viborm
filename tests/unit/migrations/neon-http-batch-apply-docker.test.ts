/**
 * Migrations over Neon HTTP (plan D7) against a real server, where other
 * sessions exist: the request's transaction lock waits for another holder and
 * gives up, and a reply lost while the request still runs — its transaction
 * holding the lock — is the ambiguous commit V11020, not a guess.
 *
 * Neon's SQL-over-HTTP endpoint is emulated in-process: each request runs on
 * a connection of its own, opened for it and closed after it, so no session
 * state outlives a request, as on Neon, whose requests may each land on
 * another backend; a batch runs in one transaction, answered in Neon's wire
 * format. Single-session behaviour is covered on PGlite by
 * `neon-http-batch-apply-pglite.test.ts`.
 *
 * Requires the Docker test database:
 *   PG_TEST_CONNECTION_STRING=postgresql://postgres:password@127.0.0.1:5434/viborm
 */

import { createClient as neonClient } from "@drivers/neon-http";
import { createClient as pgClient } from "@drivers/pg";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { neonConfig } from "@neondatabase/serverless";
import { s } from "@schema";
import type { AnyModel } from "@schema/model";
import { nekiRefusals } from "@tests/fixtures/sql-shape";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { softDeleteAccounts } from "./_catalog-digest-corpus";

const PG_CONNECTION = process.env.PG_TEST_CONNECTION_STRING;
const describeIfPg = PG_CONNECTION ? describe : describe.skip;

const NEON_URL =
  "postgres://app:secret@ep-quiet-sky-a1b2c3d4.eu-central-1.aws.neon.tech/app";
const DDL = /^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE)/i;
const MIGRATION_LOCK_ID = 0x76_69_62_6f_72_6d;
const NAMESPACE = "d7_docker";
const text = (value: string) => value;

const v1 = {
  account: s.model({ id: s.string().id(), email: s.string() }).map("accounts"),
};
const v2 = {
  account: s
    .model({
      id: s.string().id(),
      email: s.string(),
      nickname: s.string().nullable(),
    })
    .map("accounts"),
};

/** The state a `generate` published. */
function published({ stateId }: { readonly stateId: string | null }): string {
  if (stateId === null) throw new Error("generate published no state");
  return stateId;
}

describeIfPg("apply over Neon HTTP on a server with other sessions", () => {
  const pool = new pg.Pool({
    connectionString: PG_CONNECTION,
    types: { getTypeParser: () => text },
  });
  /** What the endpoint does with the next request carrying DDL. */
  let onDdl: ((client: pg.Client) => Promise<void>) | undefined;
  /** Every statement the endpoint received. */
  const received: string[] = [];
  const previousFetch = neonConfig.fetchFunction;

  async function run(
    client: pg.Client,
    query: { query: string; params?: unknown[] }
  ) {
    const result = await client.query({
      text: query.query,
      values: query.params,
      rowMode: "array",
    });
    return {
      command: result.command,
      rowCount: result.rowCount,
      fields: result.fields,
      rows: result.rows,
      rowAsArray: true,
    };
  }

  async function answer(init: RequestInit | undefined): Promise<Response> {
    const body = JSON.parse(String(init?.body));
    const queries: { query: string; params?: unknown[] }[] = body.queries ?? [
      body,
    ];
    received.push(...queries.map((query) => query.query));
    const client = new pg.Client({
      connectionString: PG_CONNECTION,
      types: { getTypeParser: () => text },
    });
    await client.connect();
    const hold = queries.some((query) => DDL.test(query.query))
      ? onDdl
      : undefined;
    if (hold) onDdl = undefined;
    try {
      if (hold) {
        await hold(client);
        throw new TypeError("fetch failed");
      }
      let reply: unknown;
      if (Array.isArray(body.queries)) {
        await client.query("BEGIN");
        try {
          const results: unknown[] = [];
          for (const query of queries) results.push(await run(client, query));
          await client.query("COMMIT");
          reply = { results };
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      } else {
        reply = await run(client, body);
      }
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      const { message, code } = error as { message: string; code?: string };
      return new Response(
        JSON.stringify({ message, code, severity: "ERROR" }),
        { status: 400 }
      );
    } finally {
      if (!hold) await client.end();
    }
  }

  beforeAll(async () => {
    neonConfig.fetchFunction = (_url: string, init?: RequestInit) =>
      answer(init);
    await pool.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${NAMESPACE}"`);
  });
  afterAll(async () => {
    neonConfig.fetchFunction = previousFetch;
    await pool.query(`DROP SCHEMA IF EXISTS "${NAMESPACE}" CASCADE`);
    await pool.end();
  });

  async function estate(
    from: Record<string, AnyModel> = v1,
    to: Record<string, AnyModel> = v2
  ) {
    await pool.query(`DROP SCHEMA "${NAMESPACE}" CASCADE`);
    await pool.query(`CREATE SCHEMA "${NAMESPACE}"`);
    const storage = new MemoryEstateStorage();
    const local = createMigrationClient(
      pgClient({
        databaseUrl: PG_CONNECTION,
        schema: from,
        namespace: NAMESPACE,
      }),
      { storage }
    );
    const root = published(await local.generate({ name: "v1" }));
    await local.apply();
    const neon = createMigrationClient(
      neonClient({ databaseUrl: NEON_URL, schema: to, namespace: NAMESPACE }),
      { storage, limits: { lockWait: 300 } }
    );
    const target = published(await neon.generate({ name: "v2" }));
    const stateId = async () => {
      const { rows } = await pool.query(
        `SELECT payload FROM "${NAMESPACE}"."_viborm_migration_state"`
      );
      return JSON.parse(rows[0].payload).stateId as string;
    };
    return { root, target, neon, stateId };
  }

  it("refuses the request while another session holds the migration lock", async () => {
    const { root, target, neon, stateId } = await estate();
    const holder = await pool.connect();
    try {
      await holder.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_ID})`);
      await expect(neon.apply({ to: { id: target } })).rejects.toMatchObject({
        code: VibORMErrorCode.MIGRATION_LOCK_FAILED,
      });
      expect(await stateId()).toBe(root);
    } finally {
      await holder.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_ID})`);
      holder.release();
    }
    await expect(neon.apply({ to: { id: target } })).resolves.toMatchObject({
      outcome: "applied",
    });
  });

  it("reports V11020 for a reply lost while the request still runs, and the marker settles it", async () => {
    const { root, target, neon, stateId } = await estate();
    let inFlight: pg.Client | undefined;
    onDdl = async (client) => {
      inFlight = client;
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_ID})`);
    };

    await expect(neon.apply({ to: { id: target } })).rejects.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect(await stateId()).toBe(root);

    await inFlight?.query("ROLLBACK");
    await inFlight?.end();
    const status = await neon.status();
    expect(status.marker?.stateId).toBe(root);
    await expect(neon.apply({ to: { id: target } })).resolves.toMatchObject({
      outcome: "applied",
    });
  });

  it("proves a partial-index origin with each canonicalization pass as one request", async () => {
    // The drift proof deparses each partial-index predicate through scratch
    // views: created, read and dropped in one request, else the read lands
    // outside the transaction that made the view. The change drops both
    // indexes, so the destination digest has no partial index to abstain on.
    const plain = {
      account: s
        .model({
          id: s.string().id(),
          email: s.string(),
          status: s.enum(["trial", "active", "churned"]).default("trial"),
          country: s.string().default("FR"),
          deletedAt: s.dateTime().nullable(),
        })
        .map("accounts"),
    };
    const { target, neon, stateId } = await estate(softDeleteAccounts(), plain);
    received.length = 0;

    await expect(neon.apply({ to: { id: target } })).resolves.toMatchObject({
      outcome: "applied",
    });
    expect(await stateId()).toBe(target);
    expect(
      received.filter((sql) => sql.includes('."viborm_index_predicate_'))
    ).not.toHaveLength(0);
    expect(nekiRefusals(received)).toEqual([]);
  });
});
