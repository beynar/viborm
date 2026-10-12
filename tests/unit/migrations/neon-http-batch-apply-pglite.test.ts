/**
 * Migrations over Neon HTTP (plan D7): with no session to hold a lock on,
 * `apply` sends each transactional group as ONE request, a non-interactive
 * batch that takes the transaction lock and asserts in SQL what the command
 * read before it (the marker, no open attempt), the transition's checks and
 * the destination's catalog digest, then moves the marker. A lost reply is
 * decided by re-reading the marker while no command holds the lock.
 *
 * Neon's SQL-over-HTTP endpoint is emulated in-process, as in the probe
 * `postgres/d7-neon-http-single-request`: `neonConfig.fetchFunction` answers
 * each request from one PGlite database in Neon's wire format (raw text
 * values, `{ results }` for a batch run in one transaction, HTTP 400 and the
 * SQLSTATE on an error). No network is used.
 */

import type { Schema } from "@client/types";
import { createClient as neonClient } from "@drivers/neon-http";
import { createClient as pgliteClient } from "@drivers/pglite";
import type { PGlite } from "@electric-sql/pglite";
import { VibORMErrorCode } from "@errors";
import { createMigrationClient } from "@migrations";
import { MemoryEstateStorage } from "@migrations/storage/memory";
import { neonConfig } from "@neondatabase/serverless";
import { s } from "@schema";
import { sql } from "@sql";
import { openTestPGlite } from "@tests/fixtures/pglite-lifecycle";
import { nekiRefusals } from "@tests/fixtures/sql-shape";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const NEON_URL =
  "postgres://app:secret@ep-quiet-sky-a1b2c3d4.eu-central-1.aws.neon.tech/app";
const DDL = /^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE)/i;
const MARKER_WRITE = /^\s*UPDATE\s+\S+\."_viborm_migration_state"/i;
const XACT_LOCK = /pg_try_advisory_xact_lock\(/;
const ADD_VALUE = /^\s*ALTER TYPE .* ADD VALUE/i;
const FIRST_WORD = /^\s*(\w+)/;

const database: PGlite = openTestPGlite();

interface NeonRequest {
  readonly batch: boolean;
  readonly statements: readonly string[];
}

/**
 * The endpoint's behaviour for the next request carrying DDL: lose its reply
 * after the commit, lose the request before the server ran it, or run
 * something first (another command moving the marker).
 */
const endpoint: {
  requests: NeonRequest[];
  lose?: "after-commit" | "before-run";
  beforeDdl?: () => Promise<unknown>;
} = { requests: [] };

const raw = () =>
  Object.fromEntries(
    Object.keys(database.parsers).map((oid) => [oid, (text: string) => text])
  );

async function run(query: { query: string; params?: unknown[] }) {
  const result = await database.query<unknown[]>(query.query, query.params, {
    rowMode: "array",
    parsers: raw(),
  });
  // The command tag PostgreSQL reports: a WITH query's is its own verb's,
  // which every one this suite sends is SELECT.
  const word = FIRST_WORD.exec(query.query)?.[1]?.toUpperCase();
  return {
    command: word === undefined || word === "WITH" ? "SELECT" : word,
    rowCount: result.affectedRows ?? result.rows.length,
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
  const request = {
    batch: Array.isArray(body.queries),
    statements: queries.map((query) => query.query),
  };
  endpoint.requests.push(request);
  const ddl = request.statements.some((text) => DDL.test(text));
  const lose = ddl ? endpoint.lose : undefined;
  if (ddl) {
    endpoint.lose = undefined;
    const before = endpoint.beforeDdl;
    endpoint.beforeDdl = undefined;
    await before?.();
  }
  if (lose === "before-run") throw new TypeError("fetch failed");
  try {
    let reply: unknown;
    if (request.batch) {
      await database.query("BEGIN");
      try {
        const results: unknown[] = [];
        for (const query of queries) results.push(await run(query));
        await database.query("COMMIT");
        reply = { results };
      } catch (error) {
        await database.query("ROLLBACK");
        throw error;
      }
    } else {
      reply = await run(body);
    }
    if (lose === "after-commit") throw new TypeError("fetch failed");
    return new Response(JSON.stringify(reply), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    if (error instanceof TypeError) throw error;
    const { message, code } = error as { message: string; code?: string };
    return new Response(JSON.stringify({ message, code, severity: "ERROR" }), {
      status: 400,
    });
  }
}

const previousFetch = neonConfig.fetchFunction;
beforeAll(async () => {
  await database.waitReady;
  neonConfig.fetchFunction = (_url: string, init?: RequestInit) => answer(init);
});
afterAll(() => {
  neonConfig.fetchFunction = previousFetch;
});

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  status: s.enum(["trial", "active"]).default("trial"),
  country: s.string().default("FR"),
  createdAt: s.dateTime().now(),
});
const v1 = { account: s.model(fields()).map("accounts") };
const v2 = {
  account: s
    .model({ ...fields(), nickname: s.string().nullable() })
    .index(["country"])
    .map("accounts"),
};

let namespaces = 0;

/** The state a `generate` published. */
function published({ stateId }: { readonly stateId: string | null }): string {
  if (stateId === null) throw new Error("generate published no state");
  return stateId;
}

/** A namespace at v1, applied through PGlite, and Neon HTTP clients over it. */
async function estate() {
  namespaces += 1;
  const namespace = `d7_${namespaces}`;
  await database.exec(`CREATE SCHEMA "${namespace}"`);
  const storage = new MemoryEstateStorage();
  const local = createMigrationClient(
    pgliteClient({ client: database, schema: v1, namespace }),
    { storage }
  );
  const root = published(await local.generate({ name: "v1" }));
  await local.apply();
  const neon = <S extends Schema>(schema: S) =>
    createMigrationClient(
      neonClient({ databaseUrl: NEON_URL, schema, namespace }),
      { storage }
    );
  const marker = async () => {
    const { rows } = await database.query<{ payload: string }>(
      `SELECT payload FROM "${namespace}"."_viborm_migration_state"`
    );
    return JSON.parse(rows[0]!.payload) as {
      stateId: string;
      revision: number;
    };
  };
  const hasColumn = async (column: string) => {
    const { rows } = await database.query(
      "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'accounts' AND column_name = $2",
      [namespace, column]
    );
    return rows.length === 1;
  };
  return { namespace, storage, root, neon, marker, hasColumn };
}

/** The requests `command` sends, and how it ended. */
async function requestsOf(command: () => Promise<unknown>) {
  const start = endpoint.requests.length;
  let failure: unknown;
  let value: unknown;
  try {
    value = await command();
  } catch (error) {
    failure = error;
  }
  const requests = endpoint.requests.slice(start);
  return {
    value,
    failure,
    requests,
    ddl: requests.filter((request) =>
      request.statements.some((text) => DDL.test(text))
    ),
  };
}

const trusted = (text: string, equals = true) => ({
  kind: "trusted-read" as const,
  query: sql.raw(text),
  equals,
});

describe("apply over Neon HTTP: one request per transactional group", () => {
  it("sends the DDL, the lock, the checks and the marker move in one batch", async () => {
    const { neon, marker, hasColumn } = await estate();
    const target = published(await neon(v2).generate({ name: "v2" }));

    const { value, failure, ddl } = await requestsOf(() =>
      neon(v2).apply({ to: { id: target } })
    );

    expect(failure).toBeUndefined();
    expect(value).toMatchObject({ outcome: "applied" });
    expect(ddl).toHaveLength(1);
    const [request] = ddl;
    expect(request?.batch).toBe(true);
    const statements = request?.statements ?? [];
    const lock = statements.findIndex((text) => XACT_LOCK.test(text));
    const firstDdl = statements.findIndex((text) => DDL.test(text));
    expect(lock).toBeGreaterThanOrEqual(0);
    expect(lock).toBeLessThan(firstDdl);
    expect(statements.some((text) => MARKER_WRITE.test(text))).toBe(true);
    expect(nekiRefusals(statements)).toEqual([]);
    expect((await marker()).stateId).toBe(target);
    expect(await hasColumn("nickname")).toBe(true);
    const log = await neon(v2).log();
    expect(log.at(-1)).toMatchObject({ kind: "applied", toState: target });
  });

  it("reports applied when the reply is lost after the commit", async () => {
    const { neon, marker } = await estate();
    const target = published(await neon(v2).generate({ name: "v2" }));

    endpoint.lose = "after-commit";
    const { value, failure } = await requestsOf(() =>
      neon(v2).apply({ to: { id: target } })
    );

    expect(failure).toBeUndefined();
    expect(value).toMatchObject({ outcome: "applied" });
    expect((await marker()).stateId).toBe(target);
  });

  it("reports the lost request as failed when it never ran, and a retry applies", async () => {
    const { neon, root, marker, hasColumn } = await estate();
    const target = published(await neon(v2).generate({ name: "v2" }));

    endpoint.lose = "before-run";
    const lost = await requestsOf(() => neon(v2).apply({ to: { id: target } }));

    expect(lost.failure).toBeDefined();
    expect(lost.failure).not.toMatchObject({
      code: VibORMErrorCode.MIGRATION_AMBIGUOUS_COMMIT,
    });
    expect((await marker()).stateId).toBe(root);
    expect(await hasColumn("nickname")).toBe(false);
    const log = await neon(v2).log();
    expect(log.at(-1)).toMatchObject({ kind: "failed", toState: target });

    const retry = await requestsOf(() =>
      neon(v2).apply({ to: { id: target } })
    );
    expect(retry.value).toMatchObject({ outcome: "applied" });
    expect((await marker()).stateId).toBe(target);
  });

  it("refuses the request when another command moved the marker after the decision", async () => {
    const { namespace, neon, hasColumn } = await estate();
    const target = published(await neon(v2).generate({ name: "v2" }));

    endpoint.beforeDdl = () =>
      database.exec(
        `UPDATE "${namespace}"."_viborm_migration_state" SET payload = jsonb_set(payload::jsonb, '{revision}', '99')::text`
      );
    const { failure, ddl } = await requestsOf(() =>
      neon(v2).apply({ to: { id: target } })
    );

    expect(ddl).toHaveLength(1);
    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_MARKER_CONFLICT,
    });
    expect(await hasColumn("nickname")).toBe(false);
  });

  it("asserts a manual transition's checks inside the request and rolls back a failing one", async () => {
    const { namespace, root, neon, marker, hasColumn } = await estate();
    const nicknamed = {
      account: s
        .model({ ...fields(), nickname: s.string().nullable() })
        .map("accounts"),
    };
    const nickname = (present: boolean) =>
      trusted(
        `SELECT count(*) = ${present ? 1 : 0} FROM information_schema.columns WHERE table_schema = '${namespace}' AND table_name = 'accounts' AND column_name = 'nickname';`
      );
    const manual = (destination: ReturnType<typeof trusted>) =>
      neon(nicknamed).generate({
        name: "manual",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "transactional",
              originChecks: [nickname(false)],
              up: [
                sql.raw(
                  `ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" TEXT`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test transition" },
            },
          ],
          destinationChecks: [destination],
        },
      });

    const failing = published(await manual(trusted("SELECT 1 = 1", false)));
    const refused = await requestsOf(() =>
      neon(nicknamed).apply({ to: { id: failing } })
    );
    expect(refused.ddl).toHaveLength(1);
    expect(refused.failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_DRIFT,
      message: "Destination checks failed before the marker could advance",
    });
    expect(nekiRefusals(refused.ddl[0]?.statements ?? [])).toEqual([]);
    expect(await hasColumn("nickname")).toBe(false);
    expect((await marker()).stateId).toBe(root);
  });

  it("refuses a check of two columns inside the request, as a session check is refused", async () => {
    const { namespace, root, neon, marker, hasColumn } = await estate();
    const nicknamed = {
      account: s
        .model({ ...fields(), nickname: s.string().nullable() })
        .map("accounts"),
    };
    const twoColumns = published(
      await neon(nicknamed).generate({
        name: "two-columns",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "transactional",
              up: [
                sql.raw(
                  `ALTER TABLE "${namespace}"."accounts" ADD COLUMN "nickname" TEXT`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test transition" },
            },
          ],
          // Its first column holds: only the second makes it malformed.
          destinationChecks: [trusted("SELECT true, 1")],
        },
      })
    );

    const refused = await requestsOf(() =>
      neon(nicknamed).apply({ to: { id: twoColumns } })
    );

    expect(refused.ddl).toHaveLength(1);
    expect(refused.failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_FAILED,
      meta: { providerSqlState: "42601" },
    });
    expect(await hasColumn("nickname")).toBe(false);
    expect((await marker()).stateId).toBe(root);
  });

  it("refuses a stepwise transition before any request carries DDL", async () => {
    const { namespace, root, neon, marker } = await estate();
    const indexed = {
      account: s.model(fields()).index(["country"]).map("accounts"),
    };
    const index = (present: boolean) =>
      trusted(
        `SELECT ${present ? "" : "NOT "}EXISTS (SELECT 1 FROM pg_catalog.pg_class WHERE relname = 'accounts_country_idx' AND relnamespace = '${namespace}'::regnamespace)`
      );
    const target = published(
      await neon(indexed).generate({
        name: "concurrently",
        manualMigration: {
          transitions: [
            {
              from: root,
              execution: "stepwise",
              originChecks: [index(false)],
              up: [
                sql.raw(
                  `CREATE INDEX CONCURRENTLY "accounts_country_idx" ON "${namespace}"."accounts" ("country")`
                ),
              ],
              rollback: { kind: "irreversible", reason: "test transition" },
            },
          ],
          destinationChecks: [index(true)],
        },
      })
    );

    const { failure, ddl } = await requestsOf(() =>
      neon(indexed).apply({ to: { id: target } })
    );

    expect(failure).toMatchObject({
      code: VibORMErrorCode.MIGRATION_UNSUPPORTED_PROVIDER,
    });
    expect(ddl).toHaveLength(0);
    expect((await marker()).stateId).toBe(root);
  });

  it("bootstraps an empty database, then applies its first state in one batch", async () => {
    namespaces += 1;
    const namespace = `d7_${namespaces}`;
    await database.exec(`CREATE SCHEMA "${namespace}"`);
    const neon = createMigrationClient(
      neonClient({ databaseUrl: NEON_URL, schema: v1, namespace }),
      { storage: new MemoryEstateStorage() }
    );
    const root = published(await neon.generate({ name: "v1" }));

    const { value, ddl } = await requestsOf(() => neon.apply());

    expect(value).toMatchObject({ outcome: "applied" });
    const batches = ddl.filter((request) => request.batch);
    expect(batches).toHaveLength(1);
    expect(
      batches[0]?.statements.some((text) => text.includes('"accounts"'))
    ).toBe(true);
    expect((await neon.status()).marker?.stateId).toBe(root);
  });

  it("commits an added enum value before the change that uses it, in two requests", async () => {
    const { neon, marker } = await estate();
    const churned = {
      account: s
        .model({
          ...fields(),
          status: s.enum(["trial", "active", "churned"]).default("trial"),
        })
        .map("accounts"),
    };
    const defaulted = {
      account: s
        .model({
          ...fields(),
          status: s.enum(["trial", "active", "churned"]).default("churned"),
        })
        .map("accounts"),
    };
    await neon(churned).generate({ name: "churned" });
    const target = published(
      await neon(defaulted).generate({ name: "defaulted" })
    );

    const { value, requests } = await requestsOf(() =>
      neon(defaulted).apply({ to: { id: target } })
    );

    expect(value).toMatchObject({ outcome: "applied" });
    const batches = requests.filter((request) => request.batch);
    expect(batches).toHaveLength(2);
    expect(batches[0]?.statements.some((text) => ADD_VALUE.test(text))).toBe(
      true
    );
    expect((await marker()).stateId).toBe(target);
  });

  it("keeps every command that needs a session refused", async () => {
    const { neon } = await estate();
    const { failure, requests } = await requestsOf(() =>
      neon(v1).down({ steps: 1 })
    );
    expect(failure).toMatchObject({
      code: VibORMErrorCode.DRIVER_NOT_SUPPORTED,
    });
    expect(requests).toHaveLength(0);
  });
});
