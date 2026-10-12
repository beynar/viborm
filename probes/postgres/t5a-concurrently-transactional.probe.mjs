// T5a (CONCURRENTLY part) + docs promise migrate.mdx:556: a manual transition
// declared `execution: 'transactional'` whose SQL is CREATE [UNIQUE] INDEX
// CONCURRENTLY is "classified stepwise or refused before effect". 1.1.0 sends
// it after BEGIN, where PostgreSQL rejects it (25001), surfacing as a generic
// V2001. The UNIQUE spelling also slips past the classifier regex
// /CREATE\s+INDEX\s+CONCURRENTLY/.
import { PGlite } from "@electric-sql/pglite";
import { s } from "viborm";
import { createMigrationClient, MemoryEstateStorage } from "viborm/migrations";
import { createClient } from "viborm/pglite";
import { sql } from "viborm/sql";

export const meta = {
  id: "t5a-concurrently-transactional",
  title:
    "CREATE [UNIQUE] INDEX CONCURRENTLY in a transactional manual transition is refused before effect (or run stepwise)",
  plan: "phase-3/T5a",
  needs: [],
  source:
    "completion-plan-2026-10/code-check-probes/postgres-transports/scripts/probe-concurrently.mjs (+ probe-concurrently.out); code-check/postgres-transports.md#T5; src/migrations/compile.ts:429-496; docs/content/docs/migration/migrate.mdx:556",
};

const BEGIN = /^(BEGIN|START TRANSACTION)\b/i;
const END = /^(COMMIT|END|ROLLBACK)\b/i;
const VARIANTS = [
  [
    "CREATE INDEX CONCURRENTLY",
    'CREATE INDEX CONCURRENTLY "accounts_email_cc" ON "public"."accounts" ("email")',
  ],
  [
    "CREATE UNIQUE INDEX CONCURRENTLY",
    'CREATE UNIQUE INDEX CONCURRENTLY "accounts_email_ucc" ON "public"."accounts" ("email")',
  ],
];

const fields = () => ({
  id: s.string().id(),
  email: s.string(),
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
const schema = { account: s.model(fields()).map("accounts") };

const decoder = new TextDecoder();

/**
 * Runs `command` and records every statement PGlite runs meanwhile, whatever
 * API sent it (query, exec or transaction): all of them reach
 * execProtocolStream, where a Parse ('P') or simple Query ('Q') message
 * carries the SQL.
 */
async function record(db, command) {
  const send = db.execProtocolStream;
  const statements = [];
  db.execProtocolStream = (message, options) => {
    if (message[0] === 0x50 || message[0] === 0x51) {
      const start = message[0] === 0x50 ? message.indexOf(0, 5) + 1 : 5;
      const sql = decoder.decode(
        message.subarray(start, message.indexOf(0, start))
      );
      statements.push(sql.replace(/\s+/g, " ").trim());
    }
    return send.call(db, message, options);
  };
  try {
    return { statements, result: await command() };
  } catch (error) {
    return { statements, error };
  } finally {
    db.execProtocolStream = send;
  }
}

/** True when `index` falls between a BEGIN and its COMMIT/ROLLBACK. */
function insideTransaction(statements, index) {
  let open = false;
  for (const [i, q] of statements.entries()) {
    if (i === index) return open;
    if (BEGIN.test(q)) open = true;
    if (END.test(q)) open = false;
  }
  return false;
}

async function variant(db, migrations, origin, [label, text]) {
  let generated;
  try {
    generated = await migrations.generate({
      name: label,
      manualMigration: {
        transitions: [
          {
            from: origin,
            execution: "transactional",
            up: [sql.raw(text)],
            rollback: { kind: "irreversible", reason: "probe" },
          },
        ],
      },
    });
  } catch (error) {
    return { ok: true, line: `${label}: refused at generate ${error?.code}` };
  }
  const { statements, result, error } = await record(db, () =>
    migrations.apply({ to: { id: generated.stateId } })
  );
  const applied = error
    ? { ok: false, code: error?.code, cause: error?.cause?.code }
    : { ok: true, outcome: result.outcome };
  const at = statements.findIndex((q) => q.includes("CONCURRENTLY"));
  const sentInside = at >= 0 && insideTransaction(statements, at);
  const ok = !sentInside && (applied.ok || applied.code !== "V2001");
  const how = applied.ok
    ? `applied (${applied.outcome})`
    : `${applied.code} (cause ${applied.cause})`;
  return {
    ok,
    line: `${label}: generate ok, apply ${how}, sent ${at < 0 ? "never" : sentInside ? "inside BEGIN" : "outside a transaction"}`,
  };
}

export default async function probe() {
  const db = new PGlite();
  try {
    const storage = new MemoryEstateStorage();
    const migrations = createMigrationClient(
      createClient({ client: db, schema }),
      { storage }
    );
    const origin = (await migrations.generate({ name: "v1" })).stateId;
    await migrations.apply();
    const results = [];
    for (const v of VARIANTS)
      results.push(await variant(db, migrations, origin, v));
    return {
      status: results.every((r) => r.ok) ? "pass" : "fail",
      evidence: results.map((r) => r.line).join(" | "),
    };
  } finally {
    await db.close();
  }
}
