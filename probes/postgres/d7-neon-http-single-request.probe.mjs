// D7: migrations over Neon HTTP, one request per transactional group. Target:
// apply() over viborm/neon-http applies a transactional change with the DDL and
// the marker compare-and-swap in ONE HTTP request (a non-interactive batch,
// checks as SQL assertions); a response lost after the server committed raises
// V11020 (ambiguous commit) or, after re-reading the marker, reports applied.
// 1.1.0 refuses every effectful command on this transport (V8002, no pinned
// session).
//
// Neon's SQL-over-HTTP endpoint is emulated in-process: neonConfig.fetchFunction
// answers each request from PGlite with Neon's wire format (raw text values,
// `{ results }` for a batch run in one transaction, HTTP 400 + SQLSTATE on
// error), so no network is used.
import { PGlite } from "@electric-sql/pglite";
import { neonConfig } from "@neondatabase/serverless";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient as neonClient } from "viborm/neon-http";
import { createClient as pgliteClient } from "viborm/pglite";

export const meta = {
  id: "d7-neon-http-single-request",
  title:
    "Neon HTTP applies a transactional change in one request; a lost response is an ambiguous commit",
  plan: "phase-4/D7",
  needs: [],
  source:
    "code-check/postgres-transports.md#D7; pg-migrations-from-durable-objects-2026-10-10/lanes/pooling.md recommended design 9 (E05: V8002 after 0 fetches); src/migrations/admission.ts:154-177; src/drivers/neon-http/index.ts:264-311",
};

const NEON_URL =
  "postgres://app:secret@ep-quiet-sky-a1b2c3d4.eu-central-1.aws.neon.tech/app";
const DDL = /^\s*(ALTER TABLE|CREATE (UNIQUE )?INDEX|CREATE TABLE)/i;
const MARKER_WRITE = /_viborm_migration_state/i;
const UPDATE = /^\s*UPDATE/i;
const FIRST_WORD = /^\s*(\w+)/;

const fields = () => ({
  id: s.string().id(),
  email: s.string().unique(),
  name: s.string(),
  status: s.enum(["trial", "active", "churned"]).default("trial"),
  balance: s.int().default(0),
  score: s.number().nullable(),
  settings: s.json().nullable(),
  country: s.string().default("FR"),
  age: s.int().nullable(),
  verified: s.boolean().default(false),
  notes: s.string().nullable(),
  lastSeenAt: s.dateTime().nullable(),
  deletedAt: s.dateTime().nullable(),
  createdAt: s.dateTime().now(),
  updatedAt: s.dateTime().updatedAt(),
});
const versions = [
  { account: s.model(fields()).map("accounts") },
  {
    account: s
      .model({ ...fields(), nickname: s.string().nullable() })
      .index(["country"])
      .map("accounts"),
  },
  {
    account: s
      .model({
        ...fields(),
        nickname: s.string().nullable(),
        referrer: s.string().nullable(),
      })
      .index(["country"])
      .map("accounts"),
  },
];

/** Neon's HTTP endpoint over one PGlite database. `loseResponseOnDdl` drops the reply after the commit. */
function neonEndpoint(db) {
  const requests = [];
  const raw = Object.fromEntries(
    Object.keys(db.parsers).map((oid) => [oid, (text) => text])
  );
  const run = async (q) => {
    const r = await db.query(q.query, q.params, {
      rowMode: "array",
      parsers: raw,
    });
    const command = FIRST_WORD.exec(q.query)?.[1]?.toUpperCase() ?? "";
    return {
      command,
      rowCount: r.affectedRows ?? r.rows.length,
      fields: r.fields,
      rows: r.rows,
      rowAsArray: true,
    };
  };
  const state = { requests, loseResponseOnDdl: false };
  state.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const queries = body.queries ?? [body];
    const request = {
      batch: Array.isArray(body.queries),
      ddl: queries.some((q) => DDL.test(q.query)),
      marker: queries.some(
        (q) => MARKER_WRITE.test(q.query) && UPDATE.test(q.query)
      ),
    };
    requests.push(request);
    try {
      let reply;
      if (request.batch) {
        await db.query("BEGIN");
        try {
          const results = [];
          for (const q of queries) results.push(await run(q));
          await db.query("COMMIT");
          reply = { results };
        } catch (error) {
          await db.query("ROLLBACK");
          throw error;
        }
      } else {
        reply = await run(body);
      }
      if (state.loseResponseOnDdl && request.ddl)
        throw new TypeError("fetch failed (probe: response lost after commit)");
      return new Response(JSON.stringify(reply), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      if (error instanceof TypeError) throw error;
      return new Response(
        JSON.stringify({
          message: error.message,
          code: error.code,
          severity: "ERROR",
        }),
        { status: 400 }
      );
    }
  };
  return state;
}

async function outcome(run) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return {
      ok: false,
      code: error?.code ?? error?.name,
      message: String(error?.message ?? error),
    };
  }
}

export default async function probe() {
  const db = new PGlite();
  const previousFetch = neonConfig.fetchFunction;
  try {
    const storage = new MemoryEstateStorage();
    const local = createMigrationClient(
      pgliteClient({ client: db, schema: versions[0] }),
      { storage }
    );
    const states = [(await local.generate({ name: "v1" })).stateId];
    await local.apply();
    const endpoint = neonEndpoint(db);
    neonConfig.fetchFunction = endpoint.fetch;
    const remote = versions.map((schema) =>
      createMigrationClient(neonClient({ databaseUrl: NEON_URL, schema }), {
        storage,
      })
    );
    for (const i of [1, 2])
      states.push((await remote[i].generate({ name: `v${i + 1}` })).stateId);

    const status = await outcome(() => remote[1].status());
    const before = endpoint.requests.length;
    const change = await outcome(() =>
      remote[1].apply({ to: { id: states[1] } })
    );
    const changeRequests = endpoint.requests.slice(before);
    const ddlRequests = changeRequests.filter((r) => r.ddl);

    endpoint.loseResponseOnDdl = true;
    const lost = await outcome(() =>
      remote[2].apply({ to: { id: states[2] } })
    );
    endpoint.loseResponseOnDdl = false;
    const marker = await db.query(
      `SELECT payload FROM "public"."_viborm_migration_state" WHERE singleton = 1`
    );
    const markerState = JSON.parse(
      typeof marker.rows[0].payload === "string"
        ? marker.rows[0].payload
        : JSON.stringify(marker.rows[0].payload)
    ).stateId;

    const problems = [];
    if (!status.ok) problems.push(`status() over HTTP threw ${status.code}`);
    if (!change.ok)
      problems.push(
        `apply threw ${change.code} after ${changeRequests.length} request(s)`
      );
    else if (
      !(
        ddlRequests.length === 1 &&
        ddlRequests[0].batch &&
        ddlRequests[0].marker
      )
    ) {
      problems.push(
        `DDL went out in ${ddlRequests.length} request(s), not one batch carrying the marker update`
      );
    }
    const lostOk = lost.ok
      ? lost.value?.outcome === "applied"
      : lost.code === "V11020";
    if (!lostOk)
      problems.push(
        `lost response gave ${lost.ok ? lost.value?.outcome : lost.code}`
      );
    if (lostOk && markerState !== states[2])
      problems.push("marker not at the committed state");
    const brief = (r) =>
      r.ok ? (r.value?.outcome ?? "ok") : `${r.code} ${r.message.slice(0, 70)}`;
    const evidence = `status: ${status.ok ? "ok" : status.code}; apply: ${brief(change)} (${changeRequests.length} requests, ${ddlRequests.length} with DDL); lost response: ${brief(lost)}`;
    return {
      status: problems.length === 0 ? "pass" : "fail",
      evidence:
        problems.length === 0
          ? evidence
          : `${problems.join("; ")} | ${evidence}`,
    };
  } finally {
    neonConfig.fetchFunction = previousFetch;
    await db.close();
  }
}
